/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import BigNumber from 'bignumber.js';
import { EventEmitter } from 'events';
import { ClientRuntimeError, NotCampaigningError } from './errors';
import { Lease } from './lease';
import { Namespace } from './namespace';
import { IKeyValue } from './rpc';
import { getDeferred, IDeferred, toBuffer } from './util';

const UnsetCurrent = Symbol('unset');

/**
 * Object returned from election.observer() that exposees information about
 * the current election.
 * @noInheritDoc
 */
export class ElectionObserver extends EventEmitter {
  /**
   * Gets whether the election has any leader.
   */
  public get hasLeader() {
    return !!this.current;
  }

  private running = true;
  private runLoop: Promise<void>;
  private disposer?: () => void;
  private current: IKeyValue | typeof UnsetCurrent | undefined = UnsetCurrent;

  constructor(private readonly namespace: Namespace) {
    super();
    this.runLoop = this.loop().catch(err => {
      this.emit('error', err);
    });
  }

  /**
   * change is fired when the elected value changes. It can be fired with
   * undefined if there's no longer a leader.
   */
  public on(event: 'change', handler: (value: string | undefined) => void): this;

  /**
   * disconnected is fired when the underlying watcher is disconnected. Etcd3
   * will automatically attempt to reconnect in the background. This has the
   * same semantics as the `disconnected` event on the {@link Watcher}.
   */
  public on(event: 'disconnected', handler: (value: Error) => void): this;

  /**
   * error is fired if the underlying election watcher
   * experiences an unrecoverable error.
   */
  public on(event: 'error', handler: (value: Error) => void): this;

  /**
   * Implements EventEmitter.on(...).
   */
  public on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  /**
   * Closes the election observer.
   */
  public async cancel() {
    this.running = false;
    this.disposer?.();
    await this.runLoop;
  }

  /**
   * Returns the currently-elected leader value (passed to `campaign()` or
   * `proclaim()`), or undefined if there's no elected leader.
   */
  public leader(encoding?: BufferEncoding): string | undefined;

  /**
   * Returns the currently-elected leader value (passed to `campaign()` or
   * `proclaim()`), or undefined if there's no elected leader.
   */
  public leader(encoding: 'buffer'): Buffer | undefined;
  public leader(encoding: BufferEncoding | 'buffer' = 'utf-8') {
    const leader = this.current;
    if (!leader || leader === UnsetCurrent) {
      return undefined;
    }

    return encoding === 'buffer' ? leader.value : leader.value.toString(encoding);
  }

  private setLeader(kv: IKeyValue | undefined) {
    const prev = this.current;
    this.current = kv;
    if (prev === UnsetCurrent) {
      this.emit('change', undefined);
    } else if (kv === undefined) {
      if (prev !== undefined) {
        this.emit('change', undefined);
      }
    } else if (!prev || !kv.value.equals(prev.value)) {
      this.emit('change', kv.value.toString());
    }
  }

  private async loop() {
    // @see https://github.com/etcd-io/etcd/blob/28d1af294e4394df1ed967a4ac4fbaf437be3463/client/v3/concurrency/election.go#L177
    while (this.running) {
      const allKeys = await this.namespace.getAll().sort('Create', 'Ascend').limit(1).exec();
      let leader: IKeyValue | undefined = allKeys.kvs[0];
      let revision = allKeys.header.revision;

      if (!this.running) {
        return; // if closed when doing async work
      }

      if (!leader) {
        this.setLeader(undefined);

        const watcher = this.namespace
          .watch()
          .startRevision(allKeys.header.revision)
          .prefix('')
          .only('put')
          .watcher();

        await new Promise<void>((resolve, reject) => {
          watcher.on('data', data => {
            let done = false;
            for (const event of data.events) {
              if (event.type === 'Put') {
                leader = event.kv;
                revision = event.kv.mod_revision;
                done = true;
              }
            }
            if (done) {
              resolve();
            }
          });
          watcher.on('error', reject);
          this.disposer = resolve;
        }).finally(() => watcher.cancel());

        if (!this.running) {
          return; // if closed when doing async work
        }
      }

      if (!leader) {
        throw new ClientRuntimeError('unreachable lack of election leader');
      }

      this.setLeader(leader);

      const watcher = this.namespace
        .watch()
        .startRevision(new BigNumber(revision).plus(1).toString())
        .key(leader.key)
        .watcher();

      await new Promise<void>((resolve, reject) => {
        watcher!.on('put', kv => this.setLeader(kv));
        watcher!.on('delete', () => resolve());
        watcher!.on('error', reject);
        this.disposer = () => {
          resolve();
          return watcher.cancel();
        };
      }).finally(() => watcher.cancel());
    }
  }
}

const ResignedCampaign = Symbol('ResignedCampaign');

/**
 * A Campaign is returned from {@link Election.campaign}. See the docs on that
 * method for an example.
 * @noInheritDoc
 */
export class Campaign extends EventEmitter {
  private lease: Lease;
  private keyRevision?: string | typeof ResignedCampaign;
  private value: Buffer;
  private pendingProclaimation?: IDeferred<void>;

  constructor(
    private readonly namespace: Namespace,
    value: string | Buffer,
    ttl: number,
  ) {
    super();
    this.value = toBuffer(value);
    this.lease = this.namespace.lease(ttl);
    this.lease.on('lost', err => this.emit('error', err));
    this.start().catch(error => {
      this.resign().catch(() => undefined);
      this.pendingProclaimation?.reject(error);
      this.emit('error', error);
    });
  }

  /**
   * elected is fired when the current instance becomes the leader.
   */
  public on(event: 'elected', handler: () => void): this;

  /**
   * error is fired if the underlying lease experiences an error. When this
   * is emitted, the campaign has failed. You should handle this and create
   * a new campaign if appropriate.
   */
  public on(event: 'error', handler: (error: Error) => void): this;

  /**
   * Implements EventEmitter.on(...).
   */
  public on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  /**
   * Helper function that returns a promise when the node becomes the leader.
   * If `resign()` is called before this happens, the promise never resolves.
   * If an error is emitted, the promise is rejected.
   */
  public wait() {
    return new Promise<this>((resolve, reject) => {
      this.on('elected', () => resolve(this));
      this.on('error', reject);
    });
  }

  /**
   * Updates the value announced by this candidate (without starting a new
   * election). If this candidate is currently the leader, then the change
   * will be seen on other consumers as well.
   *
   * @throws NotCampaigningError if the instance is no longer campaigning
   */
  public async proclaim(value: string | Buffer) {
    if (this.keyRevision === ResignedCampaign) {
      throw new NotCampaigningError();
    }

    const buf = toBuffer(value);
    if (buf.equals(this.value)) {
      return Promise.resolve();
    }

    return this.proclaimInner(buf, this.keyRevision);
  }

  /**
   * Gets the etcd key in which the proclaimed value is stored. This is derived
   * from the underlying lease, and thus may throw if the lease was not granted
   * successfully.
   */
  public async getCampaignKey() {
    const leaseId = await this.lease.grant();
    return this.namespace.prefix.toString() + leaseId;
  }

  /**
   * Resigns from the campaign. A new leader is elected if this instance was
   * formerly the leader.
   */
  public async resign() {
    if (this.keyRevision !== ResignedCampaign) {
      this.keyRevision = ResignedCampaign;
      await this.lease.revoke();
    }
  }

  private async start() {
    const leaseId = await this.lease.grant();

    const originalValue = this.value;
    const result = await this.namespace
      .if(leaseId, 'Create', '==', 0)
      .then(this.namespace.put(leaseId).value(originalValue).lease(leaseId))
      .else(this.namespace.get(leaseId))
      .commit();

    if (this.keyRevision === ResignedCampaign) {
      return; // torn down in the meantime
    }

    this.keyRevision = result.header.revision;

    if (result.succeeded) {
      if (this.pendingProclaimation) {
        await this.proclaimInner(this.value, this.keyRevision);
        this.pendingProclaimation.resolve();
      }
    } else {
      const kv = result.responses[0].response_range.kvs[0];
      this.keyRevision = kv.create_revision;
      if (!kv.value.equals(this.value)) {
        await this.proclaimInner(this.value, this.keyRevision);
        this.pendingProclaimation?.resolve();
      }
    }

    await this.waitForElected(result.header.revision);
    this.emit('elected');
  }

  private async proclaimInner(buf: Buffer, keyRevision: string | undefined) {
    if (!keyRevision) {
      this.pendingProclaimation = this.pendingProclaimation ?? getDeferred();
      this.value = buf;
      return this.pendingProclaimation.promise;
    }

    const leaseId = await this.lease.grant();
    const r = await this.namespace
      .if(leaseId, 'Create', '==', keyRevision)
      .then(this.namespace.put(leaseId).value(buf).lease(leaseId))
      .commit();
    this.value = buf;

    if (!r.succeeded) {
      this.resign().catch(() => undefined);
      throw new NotCampaigningError();
    }
  }

  private async waitForElected(revision: string) {
    // find last created before this one
    const lastRevision = new BigNumber(revision).minus(1).toString();
    const result = await this.namespace
      .getAll()
      .maxCreateRevision(lastRevision)
      .sort('Create', 'Descend')
      .limit(1)
      .exec();

    // wait for all older keys to be deleted for us to become the leader
    await waitForDeletes(
      this.namespace,
      result.kvs.map(k => k.key),
    );
  }
}

/**
 * Implementation of elections, as seen in etcd's Go client. Elections are
 * most commonly used if you need a single server in charge of a certain task;
 * you run an election on every server where your program is running, and
 * among them they will choose one "leader".
 *
 * There are two main entrypoints: campaigning via {@link Election.campaign},
 * and observing the leader via {@link Election.observe}.
 *
 * @see https://github.com/etcd-io/etcd/blob/master/client/v3/concurrency/election.go
 *
 * @example
 *
 * ```js
 * const os = require('os');
 * const client = new Etcd3();
 * const election = client.election('singleton-job');
 *
 * function runCampaign() {
 *   const campaign = election.campaign(os.hostname())
 *   campaign.on('elected', () => {
 *     // This server is now the leader! Let's start doing work
 *     doSomeWork();
 *   });
 *   campaign.on('error', error => {
 *     // An error happened that caused our campaign to fail. If we were the
 *     // leader, make sure to stop doing work (another server is the leader
 *     // now) and create a new campaign.
 *     console.error(error);
 *     stopDoingWork();
 *     setTimeout(runCampaign, 5000);
 *   });
 * }
 *
 * async function observeLeader() {
 *   const observer = await election.observe();
 *   console.log('The current leader is', observer.leader());
 *   observer.on('change', leader => console.log('The new leader is', leader));
 *   observer.on('error', () => {
 *     // Something happened that fatally interrupted observation.
 *     setTimeout(observeLeader, 5000);
 *   });
 * }
 * ```
 * @noInheritDoc
 */
export class Election {
  /**
   * Prefix used in the namespace for election-based operations.
   */
  public static readonly prefix = 'election';
  private readonly namespace: Namespace;

  /**
   * @internal
   */
  constructor(
    parent: Namespace,
    public readonly name: string,
    private readonly ttl: number = 60,
  ) {
    this.namespace = parent.namespace(`${Election.prefix}/${this.name}/`);
  }

  /**
   * Puts the value as eligible for election. Multiple sessions can participate
   * in the election, but only one can be the leader at a time.
   *
   * A common pattern in cluster-based applications is to campaign the hostname
   * or IP of the current server, and allow the leader server to be elected
   * among them.
   *
   * You should listen to the `error` and `elected` events on the returned
   * object to know when the instance becomes the leader, and when its campaign
   * fails. Once you're finished, you can use {@link Campaign.resign} to
   * forfeit its bid at leadership.
   *
   * Once acquired, instance will not lose its leadership unless `resign()`
   * is called, or `error` is emitted.
   */
  public campaign(value: string) {
    return new Campaign(this.namespace, value, this.ttl);
  }

  /**
   * Returns the currently-elected leader value (passed to `campaign()` or
   * `proclaim()`), or undefined if there's no elected leader.
   */
  public async leader(encoding?: BufferEncoding): Promise<string | undefined>;

  /**
   * Returns the currently-elected leader value (passed to `campaign()` or
   * `proclaim()`), or undefined if there's no elected leader.
   */
  public async leader(encoding: 'buffer'): Promise<Buffer | undefined>;
  public async leader(encoding: BufferEncoding | 'buffer' = 'utf-8') {
    const result = await this.namespace.getAll().sort('Create', 'Ascend').limit(1).exec();
    const leader = result.kvs[0];
    if (leader === undefined) {
      return undefined;
    }

    return encoding === 'buffer' ? leader.value : leader.value.toString();
  }

  /**
   * Creates an observer for the election, which emits events when results
   * change. The observer must be closed using `observer.cancel()` when
   * you're finished with it.
   */
  public async observe() {
    const observer = new ElectionObserver(this.namespace);
    return new Promise<ElectionObserver>((resolve, reject) => {
      observer.once('change', () => resolve(observer));
      observer.once('error', reject);
    });
  }
}

async function waitForDelete(namespace: Namespace, key: Buffer, rev: string) {
  const watcher = await namespace.watch().key(key).startRevision(rev).only('delete').create();
  const deleteOrError = new Promise((resolve, reject) => {
    watcher.once('delete', resolve);
    watcher.once('error', reject);
  });

  try {
    await deleteOrError;
  } finally {
    await watcher.cancel();
  }
}

/**
 * Returns a function that resolves when all of the given keys are deleted.
 */
async function waitForDeletes(namespace: Namespace, keys: Buffer[]) {
  for (const key of keys) {
    const res = await namespace.get(key).exec();
    if (res.kvs.length) {
      await waitForDelete(namespace, key, res.header.revision);
    }
  }
}
