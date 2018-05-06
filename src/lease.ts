import { EventEmitter } from 'events';
import * as grpc from 'grpc';

import { PutBuilder } from './builder';
import { ConnectionPool } from './connection-pool';
import { castGrpcError, EtcdError, EtcdLeaseInvalidError, GRPCConnectFailedError } from './errors';
import * as RPC from './rpc';
import { NSApplicator } from './util';

function throwIfError<T>(value: T | Error): T {
  if (value instanceof Error) {
    throw value;
  }

  return value;
}

function leaseExpired(lease: RPC.ILeaseKeepAliveResponse) {
  return lease.TTL === '0';
}

/**
 * Implements RPC.ICallable. Wraps a pool and adds the `leaseID` to outgoing
 * put requests before executing them.
 */
class LeaseClientWrapper implements RPC.ICallable {
  constructor(
    private pool: ConnectionPool,
    private readonly lease: {
      leaseID: Promise<string | Error>;
      emitLoss(err: EtcdError): void;
    },
  ) {}

  public exec(service: keyof typeof RPC.Services, method: string, payload: any): Promise<any> {
    return this.lease.leaseID
      .then(throwIfError)
      .then(lease => {
        payload.lease = lease;
        return this.pool.exec(service, method, payload);
      })
      .catch(err => {
        if (err instanceof EtcdLeaseInvalidError) {
          this.lease.emitLoss(err);
        }

        throw err;
      });
  }

  public getConnection(): never {
    throw new Error('not supported');
  }
}

const enum State {
  Alive,
  Revoked,
}

/**
 * Lease is a high-level manager for etcd leases.
 * Leases are great for things like service discovery:
 *
 * ```
 * const os = require('os');
 * const { Etcd3 } = require('etcd3');
 * const client = new Etcd3();
 *
 * const hostPrefix = 'available-hosts/';
 *
 * function grantLease() {
 *   const lease = client.lease(10); // set a TTL of 10 seconds
 *
 *   lease.on('lost', err => {
 *     console.log('We lost our lease as a result of this error:', err);
 *     console.log('Trying to re-grant it...');
 *     grantLease();
 *   })
 *
 *   await lease.put(hostPrefix + os.hostname()).value('');
 * }
 *
 * function getAvailableHosts() {
 *   const keys = await client.get().keys().strings();
 *   return keys.map(key => key.slice(hostPrefix.length));
 * }
 * ```
 */
export class Lease extends EventEmitter {
  private leaseID: Promise<string | Error>;
  private state = State.Alive;

  private client = new RPC.LeaseClient(this.pool);
  private lastKeepAlive: number;

  constructor(
    private readonly pool: ConnectionPool,
    private readonly namespace: NSApplicator,
    private ttl: number,
    private readonly options?: grpc.CallOptions,
  ) {
    super();

    if (!ttl || ttl < 1) {
      throw new Error(`The TTL in an etcd lease must be at least 1 second. Got: ${ttl}`);
    }

    this.leaseID = this.client
      .leaseGrant({ TTL: ttl }, this.options)
      .then(res => {
        this.state = State.Alive;
        this.lastKeepAlive = Date.now();
        this.keepalive();
        return res.ID;
      })
      .catch(err => {
        this.emitLoss(err);
        // return, don't throw, from here so that if no one is listening to
        // grant() we don't crash the process.
        return err;
      });
  }

  /**
   * Grant waits for the lease to be granted. You generally don't need to
   * call this, as any operations with `.put` will queue automatically.
   *
   * Calling this multiple times is safe; it won't try to request multipl leases.
   *
   * It rejects if the lease cannot be granted, in additon to the `lost`
   * event firing.
   */
  public grant(): Promise<string> {
    return this.leaseID.then(throwIfError);
  }

  /**
   * Revoke frees the lease from etcd. Keys that the lease owns will be
   * evicted.
   */
  public revoke(options: grpc.CallOptions | undefined = this.options): Promise<void> {
    this.close();
    return this.leaseID.then(id => {
      if (!(id instanceof Error)) {
        // if an error, we didn't grant in the first place
        return this.client.leaseRevoke({ ID: id }, options).then(() => undefined);
      }

      return undefined;
    });
  }

  /**
   * releasePassively stops making heartbeats for the lease, and allows it
   * to expire automatically when its TTL rolls around. Use `revoke()` to
   * actively tell etcd to terminate the lease.
   */
  public release() {
    this.close();
  }

  /**
   * Put returns a put builder that operates within the current lease.
   */
  public put(key: string | Buffer): PutBuilder {
    return new PutBuilder(
      new RPC.KVClient(new LeaseClientWrapper(this.pool, <any>this)),
      this.namespace,
      key,
    );
  }

  /**
   * keepaliveOnce fires an immediate keepalive for the lease.
   */
  public keepaliveOnce(
    options: grpc.CallOptions | undefined = this.options,
  ): Promise<RPC.ILeaseKeepAliveResponse> {
    return Promise.all([this.client.leaseKeepAlive(options), this.grant()]).then(([stream, id]) => {
      return new Promise<RPC.ILeaseKeepAliveResponse>((resolve, reject) => {
        stream.on('data', resolve);
        stream.on('error', err => reject(castGrpcError(err)));
        stream.write({ ID: id });
      }).then(res => {
        stream.end();
        if (leaseExpired(res)) {
          const err = new EtcdLeaseInvalidError(res.ID);
          this.emitLoss(err);
          throw err;
        }

        return res;
      });
    });
  }

  /**
   * Returns whether etcd has told us that this lease revoked.
   */
  public revoked(): boolean {
    return this.state === State.Revoked;
  }

  /**
   * A `lost` event is fired when etcd indicates that we've lost the lease
   * on this client. This can be a result of a number of events:
   *  - We've not been able to contact etcd for a while and our TTL has
   *    definitely expired (emits a EtcdLeaseInvalidError)
   *  - We contacted etcd and it said that the lease was expired, or revoked
   *    (emits a EtcdLeaseInvalidError).
   *  - We weren't able to get an initial grant for the lease.
   * This is NOT fired if `revoke()` is called manually.
   */
  public on(event: 'lost', handler: (err: EtcdError) => void): this;

  /**
   * keepaliveFired is emitted whenever we start
   * trying to send a lease keepalive.
   */
  public on(event: 'keepaliveFired', handler: () => void): this;

  /**
   * keepaliveSucceeded is emitted when we successfully hit etcd
   * with a keepalive for this lease.
   */
  public on(event: 'keepaliveSucceeded', handler: (res: RPC.ILeaseKeepAliveResponse) => void): this;

  /**
   * keepaliveFailed is emitted when an error happens in the keepalive loop.
   * We may be able to recover (e.g. by connecting to a different server),
   * the lease should not be considered revoked until `lost` is emitted.
   */
  public on(event: 'keepaliveFailed', handler: (res: RPC.ILeaseKeepAliveResponse) => void): this;

  /**
   * keepaliveEstablished is emitted when a stream opens that we'll use for
   * keepalives. This is mostly for testing.
   */
  public on(event: 'keepaliveEstablished', handler: () => void): this;

  /**
   * Implements EventEmitter.on(...).
   */
  public on(event: string, handler: Function): this {
    // tslint:disable-line
    return super.on(event, handler);
  }

  private teardown: () => void = () => {
    /* noop */
  };

  /**
   * Tears down resources associated with the lease.
   */
  private close() {
    this.state = State.Revoked;
    this.teardown();
  }

  /**
   * Emits the error as having caused this lease to die, and tears
   * down the lease.
   */
  private emitLoss(err: EtcdError) {
    this.close();
    this.emit('lost', err);
  }

  /**
   * keepalive starts a loop keeping the lease alive.
   */
  private keepalive() {
    // When the cluster goes down, we keep trying to reconnect. But if we're
    // far past the end of our key's TTL, there's no way we're going to be
    // able to renew it. Fire a "lost".
    if (Date.now() - this.lastKeepAlive > 2 * 1000 * this.ttl) {
      this.close();
      this.emit(
        'lost',
        new GRPCConnectFailedError('We lost connection to etcd and our lease has expired.'),
      );
      return;
    }

    this.client
      .leaseKeepAlive()
      .then(stream => {
        if (this.state !== State.Alive) {
          return stream.end();
        }

        const keepaliveTimer = setInterval(() => this.fireKeepAlive(stream), 1000 * this.ttl / 3);

        this.teardown = () => {
          this.teardown = () => undefined;
          clearInterval(keepaliveTimer);
          stream.end();
        };

        stream.on('error', err => this.handleKeepaliveError(err)).on('data', res => {
          if (leaseExpired(res)) {
            return this.handleKeepaliveError(new EtcdLeaseInvalidError(res.ID));
          }

          this.lastKeepAlive = Date.now();
          this.emit('keepaliveSucceeded', res);
        });

        this.emit('keepaliveEstablished');
        this.fireKeepAlive(stream);
      })
      .catch(err => this.handleKeepaliveError(err));
  }

  private fireKeepAlive(stream: RPC.IRequestStream<RPC.ILeaseKeepAliveRequest>) {
    this.emit('keepaliveFired');
    this.grant()
      .then(id => stream.write({ ID: id }))
      .catch(() => this.close()); // will only throw if the initial grant failed
  }

  private handleKeepaliveError(err: Error) {
    this.emit('keepaliveFailed', castGrpcError(err));
    this.teardown();

    if (err instanceof EtcdLeaseInvalidError) {
      this.emitLoss(err);
    } else {
      setTimeout(() => this.keepalive(), 100);
    }
  }
}
