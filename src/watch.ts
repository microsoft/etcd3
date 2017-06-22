import { EventEmitter } from 'events';

import { castGrpcErrorMessage, ClientRuntimeError, EtcdError } from './errors';
import { Rangable, Range } from './range';
import * as RPC from './rpc';
import { NSApplicator, onceEvent, toBuffer } from './util';

const enum State {
  Idle,
  Connecting,
  Connected,
}

/**
 * The WatchManager is a singleton that exists in namespaces to handle watching
 * multiple keys in a single GRPC stream. The underlying stream will only be
 * alive if there's at least one watcher.
 *
 * This class is not exposed externally.
 */
export class WatchManager {
  /**
   * Current state of the watcher.
   */
  private state = State.Idle;

  /**
   * The current GRPC stream, if any.
   */
  private stream: null | RPC.IDuplexStream<
    RPC.IWatchRequest,
    RPC.IWatchResponse
  >;

  /**
   * List of attached watchers.
   */
  private watchers: Watcher[] = [];

  /**
   * Set of watchers we're currently closing.
   */
  private expectedClosers = new Set<Watcher>();

  constructor(private readonly client: RPC.WatchClient) {}

  /**
   * Attach registers the watcher on the connection.
   */
  public attach(watcher: Watcher) {
    this.watchers.push(watcher);

    switch (this.state) {
      case State.Idle:
        this.establishStream();
        break;
      case State.Connecting:
        break;
      case State.Connected:
        this.getStream().write({ create_request: watcher.request });
        break;
      default:
        throw new ClientRuntimeError(`Unknown watcher state ${this.state}`);
    }
  }

  /**
   * Detaches a watcher from the connection.
   */
  public detach(watcher: Watcher): Promise<void> {
    // If we aren't connected, just remove the watcher, easy.
    if (this.state !== State.Connected) {
      this.watchers = this.watchers.filter(w => w !== watcher);
      return Promise.resolve();
    }

    // If we're awaiting an ID to come back, wait for that to happen or for
    // us to lose connection, whichever happens first.
    if (watcher.id === null) {
      return onceEvent(watcher, 'connected', 'disconnected').then(() =>
        this.detach(watcher),
      );
    }

    // If the watcher does have an ID, mark that we expect to close it and
    // run the cancellation request. The 'end' event will get fired when
    // the cancellation comes back, or if we reconnect and see that we
    // wanted to cancel the Watcher.
    this.expectedClosers.add(watcher);
    this.getStream().write({ cancel_request: { watch_id: watcher.id } });
    return onceEvent(watcher, 'end').then(() => undefined);
  }

  /**
   * Returns the current GRPC stream, *throwing* if we aren't in a state where
   * we can get the stream. Calls here are only valid if state == Connected
   */
  private getStream() {
    if (this.state !== State.Connected) {
      throw new ClientRuntimeError(
        'Cannot call getStream() if state != Connected',
      );
    }
    if (!this.stream) {
      throw new ClientRuntimeError(
        'Expected the watcher stream to exist while state == Connected',
      );
    }

    return this.stream;
  }

  /**
   * Establishes a GRPC watcher stream, if there are any active watcher.
   */
  private establishStream() {
    if (this.state !== State.Idle) {
      throw new ClientRuntimeError(
        'Cannot call establishStream() if state != Idle',
      );
    }

    // possible we reconnect and watchers are removed in the meantime
    if (this.watchers.length === 0) {
      return;
    }

    // clear anyone who is in the process of closing, we won't re-add them
    this.expectedClosers.forEach(watcher => {
      this.watchers = this.watchers.filter(w => w !== watcher);
      watcher.emit('end');
    });
    this.expectedClosers.clear();

    this.state = State.Connecting;
    this.client
      .watch()
      .then(stream => {
        this.state = State.Connected;
        this.stream = stream
          .on('data', res => this.handleResponse(res))
          .on('error', err => this.handleError(err));

        // possible watchers are remove while we're connecting.
        if (this.watchers.length === 0) {
          return this.destroyStream();
        }

        this.watchers.forEach(watcher => {
          stream.write({ create_request: watcher.request });
        });
      })
      .catch(err => this.handleError(err));
  }

  /**
   * Closes the currently attached watcher stream.
   */
  private destroyStream() {
    if (this.state !== State.Connected) {
      throw new ClientRuntimeError(
        'Cannot call establishStream() if state != Connected',
      );
    }
    if (this.watchers.length > 0) {
      throw new ClientRuntimeError(
        'Cannot call destroyStream() with active watchers',
      );
    }

    this.getStream().end();
  }

  /**
   * Handles an error emission on the current stream. Emits a message out to
   * all attached watchers and tries to reconnect.
   */
  private handleError(err: Error) {
    if (this.state === State.Connected) {
      this.getStream().end();
    }
    this.state = State.Idle;

    this.watchers.forEach(watcher => {
      watcher.emit('disconnected', err);
      (<{ id: null }>watcher).id = null;
    });

    this.establishStream();
  }

  /**
   * Handles a create response, assigning the watcher ID to the next pending
   * watcher.
   */
  private handleCreateResponse(res: RPC.IWatchResponse) {
    // responses are in-order, the response we get will be for the first
    // watcher that's waiting for its ID.
    const target = this.watchers.find(watcher => watcher.id === null);
    if (!target) {
      throw new ClientRuntimeError(
        'Could not find watcher corresponding to create response',
      );
    }

    (<{ id: string }>target).id = res.watch_id;
    target.emit('connected', res);
  }

  /**
   * Handles a cancel update, gracefully closing the watcher if it's expected,
   * or emitting an error if it's not.
   */
  private handleCancelResponse(watcher: Watcher, res: RPC.IWatchResponse) {
    this.watchers = this.watchers.filter(w => w !== watcher);

    if (this.expectedClosers.has(watcher)) {
      this.expectedClosers.delete(watcher);
      watcher.emit('end');
      return;
    }

    watcher.emit(
      'error',
      castGrpcErrorMessage(`Watcher canceled: ${res.cancel_reason}`),
    );
  }

  /**
   * Emits a data update on the target watcher.
   */
  private handleUpdateResponse(watcher: Watcher, res: RPC.IWatchResponse) {
    watcher.emit('data', res);
  }

  /**
   * Dispatches some watch response on the event stream.
   */
  private handleResponse(res: RPC.IWatchResponse) {
    if (res.created) {
      this.handleCreateResponse(res);
      return;
    }

    const watcher = this.watchers.find(w => w.id === res.watch_id);
    if (!watcher) {
      throw new ClientRuntimeError('Failed to find watcher for IWatchResponse');
    }

    if (!res.canceled) {
      this.handleUpdateResponse(watcher, res);
      return;
    }

    this.handleCancelResponse(watcher, res);
    if (this.watchers.length === 0) {
      this.destroyStream();
    }
  }
}

export const operationNames = {
  put: RPC.FilterType.Nodelete,
  delete: RPC.FilterType.Noput,
};

/**
 * WatchBuilder is used for creating etcd watchers. The created watchers are
 * resilient against disconnections, automatically resubscribing and replaying
 * changes when reconnecting.
 *
 * ```
 * const client = new Etcd3();
 *
 * client.watch()
 *   .key('foo')
 *   .create()
 *   .then(watcher => {
 *     watcher
 *       .on('disconnected', () => console.log('disconnected...'))
 *       .on('connected', () => console.log('successfully reconnected!'))
 *       .on('put', res => console.log('foo got set to:', res.value.toString());
 *   });
 * ```
 */
export class WatchBuilder {
  private request: RPC.IWatchCreateRequest = { progress_notify: true };

  constructor(
    private readonly manager: WatchManager,
    private readonly namespace: NSApplicator,
  ) {}

  /**
   * Sets a single key to be watched.
   */
  public key(key: string | Buffer): this {
    this.request.key = toBuffer(key);
    return this;
  }
  /**
   * Prefix instructs the watcher to watch all keys with the given prefix.
   */
  public prefix(value: string | Buffer): this {
    return this.inRange(Range.prefix(value));
  }

  /**
   * inRange instructs the builder to watch keys in the specified byte range.
   */
  public inRange(r: Rangable): this {
    const range = Range.from(r);
    this.request.key = range.start;
    this.request.range_end = range.end;
    return this;
  }

  /**
   * ignore omits certain operation kinds from the watch stream.
   */
  public ignore(...operations: (keyof typeof operationNames)[]): this {
    this.request.filters = operations.map(op => operationNames[op]);
    return this;
  }

  /**
   * Instructs the watcher to return the previous key/value pair in updates.
   */
  public withPreviousKV(): this {
    this.request.prev_kv = true;
    return this;
  }

  /**
   * Resolves the watch request into a Watcher, and fires off to etcd.
   */
  public create(): Promise<Watcher> {
    const watcher = new Watcher(
      this.manager,
      this.namespace,
      this.namespace.applyToRequest(this.request),
    );

    return onceEvent(watcher, 'connected').then(() => watcher);
  }
}

/**
 * The Watcher encapsulates
 */
export class Watcher extends EventEmitter {
  /**
   * id is the watcher's ID in etcd. This is `null` initially and during
   * reconnections, only populated while the watcher is idle.
   */
  public readonly id: string | null = null;

  constructor(
    private readonly manager: WatchManager,
    private readonly namespace: NSApplicator,
    public readonly request: RPC.IWatchCreateRequest,
  ) {
    super();
    this.manager.attach(this);

    this.on('data', changes => {
      changes.events.forEach(ev => {
        ev.kv.key = this.namespace.unprefix(ev.kv.key);
        if (ev.prev_kv) {
          ev.prev_kv.key = this.namespace.unprefix(ev.prev_kv.key);
        }

        this.emit(ev.type.toLowerCase(), ev.kv, ev.prev_kv);
      });

      this.request.start_revision = Number(changes.header.revision) + 1;
    });

    this.on('connected', changes => {
      this.request.start_revision = Number(changes.header.revision) + 1;
    });
  }

  /**
   * connected is fired after etcd knowledges the watcher is connected.
   * When this event is fired, `id` will already be populated.
   */
  public on(
    event: 'connected',
    handler: (res: RPC.IWatchResponse) => void,
  ): this;

  /**
   * data is fired when etcd reports an update
   * on one of the keys being watched.
   */
  public on(event: 'data', handler: (res: RPC.IWatchResponse) => void): this;

  /**
   * put is fired, in addition to `data`, when a key is created
   * or updated in etcd.
   */
  public on(
    event: 'put',
    handler: (kv: RPC.IKeyValue, previous?: RPC.IKeyValue) => void,
  ): this;

  /**
   * put is fired, in addition to `data`, when a key is deleted from etcd.
   */
  public on(
    event: 'delete',
    handler: (kv: RPC.IKeyValue, previous?: RPC.IKeyValue) => void,
  ): this;

  /**
   * end is fired after the watcher is closed normally. Like Node.js streams,
   * end is NOT fired if `error` is fired.
   */
  public on(event: 'end', handler: () => void): this;

  /**
   * disconnected is fired if the watcher is disconnected from etcd. The
   * watcher will automatically attempt to reconnect when this occurs. When
   * this event is fired, `id` will still be populated if it was previously.
   */
  public on(event: 'disconnected', handler: (res: EtcdError) => void): this;

  /**
   * error is fired if a non-recoverable error occurs that prevents the watcher
   * from functioning. This generally occurs if etcd unexpectedly canceled our
   * lease, which can occur if (for example) we don't have permission to read
   * the watched key or range. When this event is fired, `id` will still be
   * populated if it was previously.
   */
  public on(event: 'error', handler: (err: EtcdError) => void): this;
  /**
   * Implements EventEmitter.on(...).
   */
  public on(event: string, handler: Function): this {
    // tslint:disable-line
    return super.on(event, handler);
  }

  /**
   * lastRevision returns the latest etcd cluster revision that this
   * watcher observed. This will be `null` if the watcher has not yet
   * connected.
   */
  public lastRevision(): number | null {
    return <number>this.request.start_revision;
  }

  /**
   * Cancels the watcher.
   */
  public cancel(): Promise<void> {
    return this.manager.detach(this);
  }
}
