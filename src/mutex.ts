/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as grpc from '@grpc/grpc-js';

import { ComparatorBuilder } from './builder.js';
import { ConnectionPool } from './connection-pool.js';
import {
  ClientRuntimeError,
  EtcdLeaseInvalidError,
  EtcdLockFailedError,
  EtcdWatchStreamEnded,
  GRPCDeadlineExceededError,
} from './errors.js';
import { Lease } from './lease.js';
import { Range } from './range.js';
import * as RPC from './rpc.js';
import { NSApplicator, toBuffer } from './util.js';
import { WatchBuilder, Watcher } from './watch.js';

const defaultTTL = 30;
const queueMarker = Buffer.from('\0etcd3-mutex/');
const emptyValue = Buffer.alloc(0);

/**
 * Options accepted while acquiring a {@link Mutex}.
 */
export interface IMutexAcquireOptions {
  /**
   * Cancels an acquisition that is still waiting. Cancellation never releases
   * a guard that has already been returned to the caller.
   */
  signal?: AbortSignal;
}

interface AcquisitionState {
  readonly lease: Lease;
  readonly leaseID: string;
  readonly ownershipController: AbortController;
  readonly lossController: AbortController;
  readonly lostHandler: (error: Error) => void;
  activeWatcher?: Watcher;
  phase: 'waiting' | 'held' | 'released';
}

interface QueueState {
  readonly key: Buffer;
  readonly createRevision: bigint;
  readonly earliest: Buffer;
}

interface AcquiredMutex {
  readonly guard: MutexGuard;
  readonly leaseID: string;
}

type WatchFactory = () => WatchBuilder;

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error(
    signal.reason === undefined ? 'The mutex acquisition was aborted' : String(signal.reason),
  );
  error.name = 'AbortError';
  Object.assign(error, { code: 'ABORT_ERR' });
  return error;
}

function withoutDeadline(options: grpc.CallOptions | undefined): grpc.CallOptions | undefined {
  if (!options) {
    return undefined;
  }

  const { deadline: _, ...cleanupOptions } = options;
  return cleanupOptions;
}

function deadlineTime(options: grpc.CallOptions | undefined): number | undefined {
  const deadline = options?.deadline;
  if (deadline === undefined || deadline === Infinity) {
    return undefined;
  }

  return deadline instanceof Date ? deadline.getTime() : deadline;
}

/**
 * A held distributed mutex.
 *
 * Guards should normally be released with {@link MutexGuard.unlock} or an
 * `await using` declaration. The fencing token increases with each new owner
 * and should be persisted or compared by protected systems when stale owners
 * must be rejected.
 *
 * The ownership signal aborts if the lease is lost or as soon as unlocking
 * begins. Unlock stops lease keepalive before asking etcd to revoke the lease,
 * so the conservative signal remains aborted even if that request fails and a
 * later {@link MutexGuard.unlock} retries it. The signal cannot by itself
 * interrupt arbitrary callback work; consumers should pass it to abort-aware
 * operations.
 *
 * @example
 * ```ts
 * await using guard = await client.mutex(`order:${orderId}`).lock();
 * await processOrder(orderId, { signal: guard.signal });
 * ```
 */
export class MutexGuard implements AsyncDisposable {
  private unlockPromise: Promise<void> | undefined;
  private unlocked = false;

  /** The immutable create revision of the authoritative owner key. */
  public readonly fencingToken: bigint;

  /**
   * Aborts if this process learns that ownership has ended, or when
   * {@link unlock} begins. It remains aborted if revoke fails because lease
   * keepalive has already stopped. A partitioned process can still be unaware
   * that its lease expired, so use {@link fencingToken} when the protected
   * resource supports fencing.
   */
  public readonly signal: AbortSignal;

  /** @internal */
  constructor(
    fencingToken: bigint,
    signal: AbortSignal,
    private readonly createOwnershipComparator: () => ComparatorBuilder,
    private readonly release: () => Promise<void>,
  ) {
    this.fencingToken = fencingToken;
    this.signal = signal;
  }

  /**
   * Starts an etcd transaction that succeeds only while this guard still owns
   * the exact mutex key. Add operations with `.then(...)` and call `.commit()`.
   * Acquisition call options are not reused; callers may apply a fresh
   * deadline or other gRPC options with `.options(...)`.
   *
   * This compare is safer than a separate `isOwner()` check because the
   * ownership test and protected etcd writes execute atomically.
   *
   * @example
   * ```ts
   * const result = await guard.ifOwner()
   *   .then(client.put('jobs/last-run').value(new Date().toISOString()))
   *   .commit();
   * if (!result.succeeded) throw new Error('mutex ownership was lost');
   * ```
   */
  public ifOwner(): ComparatorBuilder {
    return this.createOwnershipComparator();
  }

  /**
   * Releases the mutex. The ownership signal aborts immediately when the first
   * unlock begins. Concurrent and repeated successful calls are idempotent. If
   * revocation has an indeterminate failure, the signal stays aborted and a
   * later call retries revocation.
   */
  public unlock(): Promise<void> {
    if (this.unlocked) {
      return Promise.resolve();
    }
    if (this.unlockPromise) {
      return this.unlockPromise;
    }

    this.unlockPromise = this.release().then(
      () => {
        this.unlocked = true;
      },
      error => {
        this.unlockPromise = undefined;
        throw error;
      },
    );
    return this.unlockPromise;
  }

  /** Releases this guard when used with `await using`. */
  public [Symbol.asyncDispose](): Promise<void> {
    return this.unlock();
  }
}

/**
 * A fair, lease-backed distributed mutex.
 *
 * The exact requested key is always the authoritative owner key. It has an
 * empty value and is attached to the owner's lease, which keeps this API
 * mutually exclusive with the legacy {@link Lock} protocol. Upgraded clients
 * queue with adjacent internal keys of the form
 * `K + NUL + "etcd3-mutex/" + leaseId`; applications must reserve that prefix.
 * FIFO ordering is guaranteed among upgraded contenders. During a rolling
 * migration, legacy clients may acquire the owner key between queued owners.
 *
 * @example
 * ```ts
 * await using guard = await client.mutex('inventory/rebuild').ttl(15).lock();
 * await rebuildInventory();
 * ```
 */
export class Mutex {
  private leaseTTL = defaultTTL;
  private callOptions: grpc.CallOptions | undefined;

  /** @internal */
  constructor(
    private readonly pool: ConnectionPool,
    private readonly namespace: NSApplicator,
    private readonly key: string | Buffer,
    private readonly watchFactory: WatchFactory,
  ) {}

  /**
   * Sets the automatically-kept-alive lease TTL in seconds. The default is 30
   * seconds. etcd requires a TTL of at least one second.
   */
  public ttl(seconds: number): this {
    this.leaseTTL = seconds;
    return this;
  }

  /**
   * Sets gRPC options for lease, range, and transaction calls. A deadline also
   * bounds time spent waiting on watches. Cleanup deliberately omits an
   * expired deadline so contender keys and leases can still be removed.
   */
  public options(options: grpc.CallOptions): this {
    this.callOptions = options;
    return this;
  }

  /**
   * Waits in FIFO order for ownership and returns a guard. Abort and deadline
   * failures remove this contender before rejecting.
   */
  public lock(options: IMutexAcquireOptions = {}): Promise<MutexGuard> {
    return this.engine().acquireQueued(options.signal, false).then(result => result!.guard);
  }

  /**
   * Attempts to acquire without waiting. Returns `null` when another upgraded
   * contender is earlier in the queue or the owner key is currently held.
   */
  public tryLock(options: IMutexAcquireOptions = {}): Promise<MutexGuard | null> {
    return this.engine()
      .acquireQueued(options.signal, true)
      .then(result => result?.guard ?? null);
  }

  /**
   * Acquires the mutex, invokes `callback`, and always unlocks afterward.
   * If both the callback and unlock fail, the rejection is an
   * `AggregateError` containing both failures.
   *
   * @example
   * ```ts
   * await client.mutex('reports/daily').runExclusive(async guard => {
   *   await createReport(guard.fencingToken);
   * });
   * ```
   */
  public async runExclusive<T>(
    callback: (guard: MutexGuard) => T | Promise<T>,
    options: IMutexAcquireOptions = {},
  ): Promise<T> {
    const guard = await this.lock(options);
    let result: T;
    try {
      result = await callback(guard);
    } catch (callbackError) {
      try {
        await guard.unlock();
      } catch (cleanupError) {
        throw new AggregateError(
          [callbackError, cleanupError],
          'Mutex callback and unlock both failed',
        );
      }
      throw callbackError;
    }

    try {
      await guard.unlock();
    } catch (cleanupError) {
      throw cleanupError;
    }
    return result;
  }

  private engine() {
    return new MutexEngine(
      this.pool,
      this.namespace,
      this.key,
      this.leaseTTL,
      this.callOptions,
      this.watchFactory,
    );
  }
}

/**
 * Shared implementation for the queued Mutex API and immediate legacy Lock.
 * @internal
 */
export class MutexEngine {
  private readonly kv: RPC.KVClient;
  private readonly localKey: Buffer;
  private readonly ownerKey: Buffer;
  private readonly localQueuePrefix: Buffer;
  private readonly cleanupOptions: grpc.CallOptions | undefined;

  constructor(
    private readonly pool: ConnectionPool,
    private readonly namespace: NSApplicator,
    key: string | Buffer,
    private readonly leaseTTL: number,
    private readonly callOptions: grpc.CallOptions | undefined,
    private readonly watchFactory?: WatchFactory,
  ) {
    this.kv = new RPC.KVClient(pool);
    this.localKey = toBuffer(key);
    this.ownerKey = namespace.applyKey(this.localKey)!;
    this.localQueuePrefix = Buffer.concat([this.localKey, queueMarker]);
    this.cleanupOptions = withoutDeadline(callOptions);
  }

  public async acquireImmediate(
    onLeaseGranted?: (leaseID: string) => void,
    onLeaseGrantFailed?: (error: unknown) => void,
  ): Promise<AcquiredMutex> {
    let state: AcquisitionState;
    try {
      state = await this.createAcquisition();
      onLeaseGranted?.(state.leaseID);
    } catch (error) {
      onLeaseGrantFailed?.(error);
      throw error;
    }
    try {
      const response = await new ComparatorBuilder(this.kv, this.namespace)
        .and(this.localKey, 'Create', '==', 0)
        .then({
          request_put: this.namespace.applyToRequest({
            key: this.localKey,
            value: emptyValue,
            lease: state.leaseID,
          }),
        })
        .options(this.callOptions)
        .commit();

      if (!response.succeeded) {
        throw new EtcdLockFailedError(`Failed to acquire a lock on ${String(this.localKey)}`);
      }

      this.assertLeaseAlive(state);
      return this.hold(state, BigInt(response.header.revision));
    } catch (error) {
      return this.failAcquisition(state, error, 'Failed to acquire a lock and release its lease');
    }
  }

  public async acquireQueued(
    signal: AbortSignal | undefined,
    nonblocking: boolean,
  ): Promise<AcquiredMutex | null> {
    this.assertNotAborted(signal);
    const state = await this.createAcquisition();

    try {
      this.assertActive(state, signal);
      const queue = await this.createContender(state);
      this.assertActive(state, signal);

      if (nonblocking && !queue.earliest.equals(queue.key)) {
        await this.releaseAcquisition(state);
        return null;
      }

      if (!nonblocking) {
        await this.waitForTurn(state, queue, signal);
      }

      const claimed = await this.claimOwner(state, queue, signal, nonblocking);
      if (claimed !== null) {
        return claimed;
      }

      if (nonblocking) {
        await this.releaseAcquisition(state);
        return null;
      }

      throw new ClientRuntimeError('queued mutex acquisition exited without ownership');
    } catch (error) {
      if (state.phase === 'released') {
        throw error;
      }
      return this.failAcquisition(state, error);
    }
  }

  private async createAcquisition(): Promise<AcquisitionState> {
    const lease = new Lease(this.pool, this.namespace, this.leaseTTL, this.callOptions);
    const ownershipController = new AbortController();
    const lossController = new AbortController();
    const state = {
      lease,
      leaseID: '',
      ownershipController,
      lossController,
      phase: 'waiting' as const,
      lostHandler: (error: Error) => {
        if (!lossController.signal.aborted) {
          lossController.abort(error);
        }
        if (!ownershipController.signal.aborted) {
          ownershipController.abort(error);
        }
      },
    };
    lease.on('lost', state.lostHandler);

    try {
      (state as { leaseID: string }).leaseID = await lease.grant();
      this.assertLeaseAlive(state);
      return state;
    } catch (error) {
      lease.off('lost', state.lostHandler);
      try {
        await lease.revoke(this.cleanupOptions);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Failed to grant and clean up a mutex lease',
        );
      }
      throw error;
    }
  }

  private async createContender(state: AcquisitionState): Promise<QueueState> {
    const localQueueKey = Buffer.concat([this.localQueuePrefix, Buffer.from(state.leaseID)]);
    const queueKey = this.namespace.applyKey(localQueueKey)!;
    const queueRange = this.namespace.applyToRequest({
      key: Range.prefix(this.localQueuePrefix).start,
      range_end: Range.prefix(this.localQueuePrefix).end,
      sort_order: RPC.SortOrder.Ascend,
      sort_target: RPC.SortTarget.Create,
      limit: 1,
    });
    const queueKeyRange = this.namespace.applyToRequest({ key: localQueueKey, limit: 1 });
    const putQueue = this.namespace.applyToRequest({
      key: localQueueKey,
      value: emptyValue,
      lease: state.leaseID,
    });

    const response = await this.kv.txn(
      {
        compare: [
          {
            key: queueKey,
            target: RPC.CompareTarget.Create,
            result: RPC.CompareResult.Equal,
            create_revision: 0,
          },
        ],
        success: [
          { request_put: putQueue },
          { request_range: queueKeyRange },
          { request_range: queueRange },
        ],
        failure: [{ request_range: queueKeyRange }, { request_range: queueRange }],
      },
      this.callOptions,
    );

    const ownRange = response.responses[response.succeeded ? 1 : 0]?.response_range;
    const earliestRange = response.responses[response.succeeded ? 2 : 1]?.response_range;
    const ownKV = ownRange?.kvs[0];
    const earliest = earliestRange?.kvs[0];
    if (response.succeeded && ownKV === undefined) {
      return {
        key: queueKey,
        createRevision: BigInt(response.header.revision),
        earliest: earliest?.key ?? queueKey,
      };
    }
    if (!ownKV || ownKV.lease !== state.leaseID) {
      throw new EtcdLeaseInvalidError(state.leaseID);
    }
    if (!earliest) {
      throw new ClientRuntimeError('mutex queue was empty after creating a contender');
    }

    return {
      key: queueKey,
      createRevision: BigInt(ownKV.create_revision),
      earliest: earliest.key,
    };
  }

  private async waitForTurn(
    state: AcquisitionState,
    queue: QueueState,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let initialEarliest: Buffer | undefined = queue.earliest;

    while (true) {
      this.assertActive(state, signal);
      if (initialEarliest?.equals(queue.key)) {
        return;
      }
      initialEarliest = undefined;

      const predecessor = await this.kv.range(
        this.namespace.applyToRequest({
          key: Range.prefix(this.localQueuePrefix).start,
          range_end: Range.prefix(this.localQueuePrefix).end,
          max_create_revision: (queue.createRevision - 1n).toString(),
          sort_order: RPC.SortOrder.Descend,
          sort_target: RPC.SortTarget.Create,
          limit: 1,
        }),
        this.callOptions,
      );
      this.assertActive(state, signal);

      if (predecessor.kvs.length === 0) {
        return;
      }

      await this.waitForDeletion(state, predecessor.kvs[0].key, predecessor.header.revision, signal);
    }
  }

  private async claimOwner(
    state: AcquisitionState,
    queue: QueueState,
    signal: AbortSignal | undefined,
    nonblocking: boolean,
  ): Promise<AcquiredMutex | null> {
    while (true) {
      this.assertActive(state, signal);
      const ownerRange = { key: this.ownerKey, limit: 1 };
      const response = await this.kv.txn(
        {
          compare: [
            {
              key: queue.key,
              target: RPC.CompareTarget.Create,
              result: RPC.CompareResult.Equal,
              create_revision: queue.createRevision.toString(),
            },
            {
              key: this.ownerKey,
              target: RPC.CompareTarget.Create,
              result: RPC.CompareResult.Equal,
              create_revision: 0,
            },
          ],
          success: [
            {
              request_put: {
                key: this.ownerKey,
                value: emptyValue,
                lease: state.leaseID,
              },
            },
            { request_range: ownerRange },
          ],
          failure: [{ request_range: { key: queue.key, limit: 1 } }, { request_range: ownerRange }],
        },
        this.callOptions,
      );
      this.assertActive(state, signal);

      if (response.succeeded) {
        const owner = response.responses[1]?.response_range.kvs[0];
        const token = owner?.create_revision ?? response.header.revision;
        return this.hold(state, BigInt(token));
      }

      const contender = response.responses[0]?.response_range.kvs[0];
      const owner = response.responses[1]?.response_range.kvs[0];
      if (owner?.lease === state.leaseID) {
        return this.hold(state, BigInt(owner.create_revision));
      }
      if (!contender || contender.create_revision !== queue.createRevision.toString()) {
        throw state.lossController.signal.aborted
          ? abortReason(state.lossController.signal)
          : new EtcdLeaseInvalidError(state.leaseID);
      }
      if (!owner) {
        continue;
      }
      if (nonblocking || !this.watchFactory) {
        return null;
      }

      await this.waitForDeletion(state, owner.key, response.header.revision, signal);
      await this.waitForTurn(state, queue, signal);
    }
  }

  private async waitForDeletion(
    state: AcquisitionState,
    key: Buffer,
    revision: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!this.watchFactory) {
      throw new ClientRuntimeError('mutex watch factory was not configured');
    }

    this.assertActive(state, signal);
    const localKey = this.namespace.unprefix(key);
    const watcher = this.watchFactory()
      .key(localKey)
      .startRevision(revision)
      .only('delete')
      .watcher();
    state.activeWatcher = watcher;

    let operationError: unknown;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          watcher.off('delete', onDelete);
          watcher.off('error', onError);
          watcher.off('end', onEnd);
          signal?.removeEventListener('abort', onAbort);
          state.lossController.signal.removeEventListener('abort', onLoss);
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          fn();
        };
        const onDelete = () => finish(resolve);
        const onError = (error: Error) => finish(() => reject(error));
        const onEnd = () => finish(() => reject(new EtcdWatchStreamEnded()));
        const onAbort = () => finish(() => reject(abortReason(signal!)));
        const onLoss = () =>
          finish(() => reject(abortReason(state.lossController.signal)));

        watcher.once('delete', onDelete);
        watcher.once('error', onError);
        watcher.once('end', onEnd);
        signal?.addEventListener('abort', onAbort, { once: true });
        state.lossController.signal.addEventListener('abort', onLoss, { once: true });

        if (signal?.aborted) {
          onAbort();
        } else if (state.lossController.signal.aborted) {
          onLoss();
        }

        const deadline = settled ? undefined : deadlineTime(this.callOptions);
        if (deadline !== undefined) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            finish(() => reject(new GRPCDeadlineExceededError('Mutex wait deadline exceeded')));
          } else {
            timer = setTimeout(
              () =>
                finish(() =>
                  reject(new GRPCDeadlineExceededError('Mutex wait deadline exceeded')),
                ),
              remaining,
            );
          }
        }
      });
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (state.activeWatcher === watcher) {
        state.activeWatcher = undefined;
      }
      try {
        await watcher.cancel();
      } catch (cleanupError) {
        if (operationError !== undefined) {
          throw new AggregateError(
            [operationError, cleanupError],
            'Mutex wait and watcher cleanup both failed',
          );
        }
        throw cleanupError;
      }
    }
  }

  private hold(state: AcquisitionState, fencingToken: bigint): AcquiredMutex {
    state.phase = 'held';
    const guard = new MutexGuard(
      fencingToken,
      state.ownershipController.signal,
      () =>
        new ComparatorBuilder(this.kv, this.namespace)
          .and(this.localKey, 'Create', '==', fencingToken.toString()),
      () => this.releaseAcquisition(state),
    );
    return { guard, leaseID: state.leaseID };
  }

  private async releaseAcquisition(state: AcquisitionState): Promise<void> {
    if (state.phase === 'released') {
      return;
    }

    if (state.phase === 'held' && !state.ownershipController.signal.aborted) {
      state.ownershipController.abort(new Error('Mutex guard is being unlocked'));
    }
    await state.lease.revoke(this.cleanupOptions);
    state.phase = 'released';
    state.lease.off('lost', state.lostHandler);
  }

  private async failAcquisition(
    state: AcquisitionState,
    error: unknown,
    message = 'Failed to acquire a mutex and release its lease',
  ): Promise<never> {
    try {
      await this.releaseAcquisition(state);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        message,
      );
    }
    throw error;
  }

  private assertNotAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
  }

  private assertLeaseAlive(state: AcquisitionState) {
    if (state.lossController.signal.aborted) {
      throw abortReason(state.lossController.signal);
    }
  }

  private assertActive(state: AcquisitionState, signal: AbortSignal | undefined) {
    this.assertNotAborted(signal);
    this.assertLeaseAlive(state);
  }
}
