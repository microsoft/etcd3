/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as grpc from '@grpc/grpc-js';

import { ConnectionPool } from './connection-pool.js';
import { EtcdLockFailedError } from './errors.js';
import { MutexEngine, MutexGuard } from './mutex.js';
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
export class Lock implements AsyncDisposable {
  private leaseTTL = 30;
  private guard: MutexGuard | null = null;
  private acquiredLeaseID: string | null = null;
  private pendingAcquisition: Promise<{ guard: MutexGuard; leaseID: string }> | null = null;
  private pendingLeaseID: Promise<string> | null = null;
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
    if (this.guard || this.pendingAcquisition) {
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
    if (this.guard || this.pendingAcquisition) {
      throw new EtcdLockFailedError(
        `Failed to acquire a lock on ${this.key}: lock is already acquired`,
      );
    }

    let resolveLeaseID!: (leaseID: string) => void;
    let rejectLeaseID!: (error: unknown) => void;
    const pendingLeaseID = new Promise<string>((resolve, reject) => {
      resolveLeaseID = resolve;
      rejectLeaseID = reject;
    });
    // leaseId() may never be called, but a failed grant must not become an
    // unhandled rejection.
    void pendingLeaseID.catch(() => undefined);

    const pending = new MutexEngine(
      this.pool,
      this.namespace,
      this.key,
      this.leaseTTL,
      this.callOptions,
    ).acquireImmediate(resolveLeaseID, rejectLeaseID);
    this.pendingAcquisition = pending;
    this.pendingLeaseID = pendingLeaseID;

    try {
      const acquired = await pending;
      this.guard = acquired.guard;
      this.acquiredLeaseID = acquired.leaseID;
      return this;
    } finally {
      if (this.pendingAcquisition === pending) {
        this.pendingAcquisition = null;
        this.pendingLeaseID = null;
      }
    }
  }

  /**
   * Returns the lease associated with this lock, if any. Returns null if
   * the lock has not been acquired.
   */
  public leaseId(): Promise<string | null> {
    if (this.acquiredLeaseID) {
      return Promise.resolve(this.acquiredLeaseID);
    }

    return this.pendingLeaseID ?? Promise.resolve(null);
  }

  /**
   * Release frees the lock.
   */
  public release(): Promise<void> {
    const guard = this.guard;
    if (!guard) {
      throw new Error('Attempted to release a lock which was not acquired');
    }

    return guard.unlock().then(() => {
      if (this.guard === guard) {
        this.guard = null;
        this.acquiredLeaseID = null;
      }
    });
  }

  /** Releases an acquired lock when used with `await using`. */
  public [Symbol.asyncDispose](): Promise<void> {
    return this.guard ? this.release() : Promise.resolve();
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
}
