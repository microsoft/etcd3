/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as grpc from '@grpc/grpc-js';

import { ComparatorBuilder, PutBuilder } from './builder.js';
import { ConnectionPool } from './connection-pool.js';
import { EtcdLockFailedError } from './errors.js';
import { Lease } from './lease.js';
import * as RPC from './rpc.js';
import { NSApplicator } from './util.js';

/**
 * A Lock can be used for distributed locking to create atomic operations
 * across multiple systems. An EtcdLockFailedError is thrown if the lock
 * can't be acquired.
 *
 * Under the hood, the Lock uses a lease on a key which is revoked when the
 * the lock is released. If the server the lock is running on dies, or the
 * network is disconnected, etcd will time out the lock.
 *
 * Bear in mind that this means that in certain rare situations (a network
 * disconnect or wholesale etcd failure), the caller may lose the lock while
 * operations may still be running.
 *
 * A quick example:
 *
 * ```
 * import { Etcd3 } from 'etcd3';
 * const client = new Etcd3();
 *
 * client.lock('my_resource').do(() => {
 *   // The lock will automatically be released when this promise returns
 *   return doMyAtomicAction();
 * });
 * ```
 */
export class Lock {
  private leaseTTL = 30;
  private lease: Lease | null = null;
  private callOptions: grpc.CallOptions | undefined;

  constructor(
    private readonly pool: ConnectionPool,
    private readonly namespace: NSApplicator,
    private key: string | Buffer,
  ) {}

  /**
   * Sets the TTL of the lease underlying the lock. The lease TTL defaults
   * to 30 seconds.
   */
  public ttl(seconds: number): this {
    if (this.lease) {
      throw new Error('Cannot set a lock TTL after acquiring the lock');
    }

    this.leaseTTL = seconds;
    return this;
  }

  /**
   * Sets the GRPC call options for this request.
   */
  public options(options: grpc.CallOptions): this {
    this.callOptions = options;
    return this;
  }

  /**
   * Acquire attempts to acquire the lock, rejecting if it's unable to.
   */
  public async acquire(): Promise<this> {
    if (this.lease) {
      throw new EtcdLockFailedError(
        `Failed to acquire a lock on ${this.key}: lock is already acquired`,
      );
    }

    const lease = (this.lease = new Lease(
      this.pool,
      this.namespace,
      this.leaseTTL,
      this.callOptions,
    ));
    const kv = new RPC.KVClient(this.pool);

    let leaseID: string;
    try {
      leaseID = await lease.grant();
    } catch (error) {
      this.lease = null;
      throw error;
    }

    let res: RPC.ITxnResponse;
    try {
      res = await new ComparatorBuilder(kv, this.namespace)
        .and(this.key, 'Create', '==', 0)
        .then(new PutBuilder(kv, this.namespace, this.key).value('').lease(leaseID))
        .options(this.callOptions)
        .commit();
    } catch (error) {
      return this.cleanupFailedAcquire(lease, error);
    }

    if (res.succeeded) {
      return this;
    }

    return this.cleanupFailedAcquire(
      lease,
      new EtcdLockFailedError(`Failed to acquire a lock on ${this.key}`),
    );
  }

  /**
   * Returns the lease associated with this lock, if any. Returns null if
   * the lock has not been acquired.
   */
  public leaseId(): Promise<string | null> {
    return this.lease ? this.lease.grant() : Promise.resolve(null);
  }

  /**
   * Release frees the lock.
   */
  public release(): Promise<void> {
    const lease = this.lease;
    if (!lease) {
      throw new Error('Attempted to release a lock which was not acquired');
    }

    return lease.revoke().then(() => {
      if (this.lease === lease) {
        this.lease = null;
      }
    });
  }

  /**
   * `do()` wraps the inner function. It acquires the lock before running
   * the function, and releases the lock after any promise the function
   * returns resolves or throws.
   */
  public async do<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  private async cleanupFailedAcquire(lease: Lease, error: unknown): Promise<never> {
    try {
      await lease.revoke();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Failed to acquire a lock and release its lease',
      );
    }

    if (this.lease === lease) {
      this.lease = null;
    }

    throw error;
  }
}
