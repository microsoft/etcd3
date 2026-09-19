/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Etcd3,
  EtcdLeaseInvalidError,
  EtcdLockFailedError,
  GRPCDeadlineExceededError,
  MutexGuard,
} from '../index.js';
import { createTestClient, tearDownTestClient } from './util.js';

const queuePrefix = (key: string) => Buffer.from(`${key}\0etcd3-mutex/`);

describe('mutex()', () => {
  let client: Etcd3;

  beforeEach(() => {
    client = createTestClient();
  });

  afterEach(async () => {
    await tearDownTestClient(client);
  });

  it('uses the requested key as the leased owner key and returns a fencing token', async () => {
    const guard = await client.mutex('resource').lock();
    try {
      const owner = (await client.get('resource').exec()).kvs[0];
      expect(owner.value).toEqual(Buffer.alloc(0));
      expect(owner.lease).not.toBe('0');
      expect(guard.fencingToken).toBe(BigInt(owner.create_revision));
      expect(guard.signal.aborted).toBe(false);
    } finally {
      await guard.unlock();
    }

    expect(await client.get('resource').buffer()).toBeNull();
    expect(guard.signal.aborted).toBe(true);
  });

  it('queues blocking acquisitions in FIFO order', async () => {
    const first = await client.mutex('fifo').lock();
    const order: number[] = [];
    let secondGuard;
    let thirdGuard;

    try {
      const second = client
        .mutex('fifo')
        .lock()
        .then(guard => {
          secondGuard = guard;
          order.push(2);
          return guard;
        });
      await vi.waitFor(async () => {
        expect(await client.getAll().prefix(queuePrefix('fifo')).count()).toBe(2);
      });

      const third = client
        .mutex('fifo')
        .lock()
        .then(guard => {
          thirdGuard = guard;
          order.push(3);
          return guard;
        });
      await vi.waitFor(async () => {
        expect(await client.getAll().prefix(queuePrefix('fifo')).count()).toBe(3);
      });

      await first.unlock();
      secondGuard = await second;
      expect(order).toEqual([2]);
      await secondGuard.unlock();
      thirdGuard = await third;
      expect(order).toEqual([2, 3]);
    } finally {
      await first.unlock();
      await secondGuard?.unlock();
      await thirdGuard?.unlock();
    }
  });

  it('tryLock returns null without leaving a contender', async () => {
    const holder = await client.mutex('try').lock();
    try {
      await expect(client.mutex('try').tryLock()).resolves.toBeNull();
      expect(await client.getAll().prefix(queuePrefix('try')).count()).toBe(1);
    } finally {
      await holder.unlock();
    }
  });

  it('tryLock immediately returns a guard when the mutex is free', async () => {
    const guard = await client.mutex('try-free').tryLock();
    expect(guard).toBeInstanceOf(MutexGuard);
    await guard!.unlock();
  });

  it('cancels a queued acquisition and removes its contender', async () => {
    const holder = await client.mutex('abort').lock();
    const controller = new AbortController();
    const reason = new Error('stop waiting');
    const waiting = client.mutex('abort').lock({ signal: controller.signal });

    try {
      await vi.waitFor(async () => {
        expect(await client.getAll().prefix(queuePrefix('abort')).count()).toBe(2);
      });
      controller.abort(reason);
      await expect(waiting).rejects.toBe(reason);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      expect(await client.getAll().prefix(queuePrefix('abort')).count()).toBe(1);
    } finally {
      controller.abort();
      await waiting.catch(() => undefined);
      await holder.unlock();
    }
  });

  it('applies a gRPC deadline to watch waiting and cleans up afterward', async () => {
    const holder = await client.mutex('deadline').lock();
    try {
      const waiting = client
        .mutex('deadline')
        .options({ deadline: new Date(Date.now() + 500) })
        .lock();
      await expect(waiting).rejects.toBeInstanceOf(GRPCDeadlineExceededError);
      expect(await client.getAll().prefix(queuePrefix('deadline')).count()).toBe(1);
    } finally {
      await holder.unlock();
    }
  });

  it('supports runExclusive, idempotent disposal, and increasing fencing tokens', async () => {
    let firstToken = 0n;
    await client.mutex('exclusive').runExclusive(async guard => {
      firstToken = guard.fencingToken;
      expect(await client.mutex('exclusive').tryLock()).toBeNull();
    });

    const next = await client.mutex('exclusive').lock();
    expect(next.fencingToken).toBeGreaterThan(firstToken);
    await Promise.all([next.unlock(), next.unlock(), next[Symbol.asyncDispose]()]);

    let disposalSignal: AbortSignal | undefined;
    {
      await using disposable = await client.mutex('exclusive').lock();
      disposalSignal = disposable.signal;
    }
    expect(disposalSignal?.aborted).toBe(true);
  });

  it('aborts ownership when unlock begins and retries a failed revoke', async () => {
    const guard = await client.mutex('retry-unlock').lock();
    const revokeError = new Error('indeterminate revoke failure');
    const exec = vi
      .fn()
      .mockRejectedValueOnce(revokeError)
      .mockResolvedValueOnce({});
    client.mock({ exec: exec as any });

    try {
      const firstUnlock = guard.unlock();
      expect(guard.signal.aborted).toBe(true);
      await expect(firstUnlock).rejects.toBe(revokeError);
      expect(guard.signal.aborted).toBe(true);

      await expect(guard.unlock()).resolves.toBeUndefined();
      expect(exec).toHaveBeenCalledTimes(2);
      expect(exec.mock.calls.map(([, method]) => method)).toEqual([
        'leaseRevoke',
        'leaseRevoke',
      ]);
    } finally {
      client.unmock();
      await client.delete().key('retry-unlock');
    }
  });

  it('provides an atomic ownership comparator', async () => {
    const guard = await client.mutex('compare').lock();
    expect(
      (
        await guard
          .ifOwner()
          .then(client.put('protected').value('owned'))
          .commit()
      ).succeeded,
    ).toBe(true);
    await guard.unlock();

    expect(
      (
        await guard
          .ifOwner()
          .then(client.put('protected').value('stale'))
          .commit()
      ).succeeded,
    ).toBe(false);
    expect(await client.get('protected').string()).toBe('owned');
  });

  it('does not reuse an expired acquisition deadline for ifOwner transactions', async () => {
    const deadline = new Date(Date.now() + 1_000);
    const guard = await client.mutex('fresh-owner-options').options({ deadline }).lock();

    try {
      await new Promise(resolve => setTimeout(resolve, deadline.getTime() - Date.now() + 100));
      const result = await guard
        .ifOwner()
        .then(client.put('fresh-owner-write').value('written'))
        .commit();

      expect(result.succeeded).toBe(true);
      expect(await client.get('fresh-owner-write').string()).toBe('written');
    } finally {
      await guard.unlock();
    }
  });

  it('applies namespace prefixes to owner and internal queue keys', async () => {
    const namespace = client.namespace('tenant/');
    const guard = await namespace.mutex('resource').lock();
    try {
      expect(await client.get('resource').string()).toBeNull();
      expect(await client.get('tenant/resource').string()).toBe('');
      expect(await namespace.getAll().prefix(queuePrefix('resource')).count()).toBe(1);
    } finally {
      await guard.unlock();
    }
  });

  it('excludes legacy locks in both acquisition directions', async () => {
    const legacy = await client.lock('mixed').acquire();
    const waiting = client.mutex('mixed').lock();
    let mutexGuard;
    try {
      await vi.waitFor(async () => {
        expect(await client.getAll().prefix(queuePrefix('mixed')).count()).toBe(1);
      });
      await legacy.release();
      mutexGuard = await waiting;
      await expect(client.lock('mixed').acquire()).rejects.toBeInstanceOf(EtcdLockFailedError);
    } finally {
      if (await legacy.leaseId()) {
        await legacy.release();
      }
      await mutexGuard?.unlock();
    }
  });

  it('interoperates with the raw legacy owner-key protocol in both directions', async () => {
    const rawLease = client.lease(10);
    await rawLease.put('raw-mixed').value('');
    await expect(client.mutex('raw-mixed').tryLock()).resolves.toBeNull();
    const waiting = client.mutex('raw-mixed').lock();
    let guard;

    try {
      await vi.waitFor(async () => {
        expect(await client.getAll().prefix(queuePrefix('raw-mixed')).count()).toBe(1);
      });
      await rawLease.revoke();
      guard = await waiting;

      const contenderLease = client.lease(10);
      const contenderID = await contenderLease.grant();
      try {
        const legacyClaim = await client
          .if('raw-mixed', 'Create', '==', 0)
          .then(client.put('raw-mixed').value('').lease(contenderID))
          .commit();
        expect(legacyClaim.succeeded).toBe(false);
      } finally {
        await contenderLease.revoke();
      }
    } finally {
      await rawLease.revoke();
      await guard?.unlock();
    }
  });

  it('aggregates acquisition and cleanup failures and omits expired cleanup deadlines', async () => {
    const acquisitionError = new Error('acquisition failed');
    const cleanupError = new Error('cleanup failed');
    const callOptions = { deadline: new Date(0), waitForReady: true };
    const exec = vi.fn((service: string, method: string, _: unknown, options?: unknown) => {
      if (service === 'Lease' && method === 'leaseGrant') {
        return Promise.resolve({ ID: '123', TTL: '30' });
      }
      if (service === 'KV' && method === 'txn') {
        return Promise.reject(acquisitionError);
      }
      if (service === 'Lease' && method === 'leaseRevoke') {
        expect(options).toEqual({ waitForReady: true });
        return Promise.reject(cleanupError);
      }
      throw new Error(`Unexpected call: ${service}.${method}`);
    });
    client.mock({ exec: exec as any });

    try {
      const error = await client
        .mutex('cleanup')
        .options(callOptions)
        .tryLock()
        .catch(error => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([acquisitionError, cleanupError]);
    } finally {
      client.unmock();
    }
  });

  it('aborts ownership when the underlying lease is lost', async () => {
    const guard = await client.mutex('lease-loss').ttl(1).lock();
    const owner = (await client.get('lease-loss').exec()).kvs[0];
    await client.leaseClient.leaseRevoke({ ID: owner.lease });

    await vi.waitFor(() => expect(guard.signal.aborted).toBe(true), {
      timeout: 3_000,
    });
    await expect(guard.unlock()).resolves.toBeUndefined();
  });

  it('rejects a queued acquisition whose lease is lost', async () => {
    const holder = await client.mutex('queued-loss').lock();
    const waiting = client.mutex('queued-loss').ttl(1).lock();
    try {
      let queuedLease = '';
      await vi.waitFor(async () => {
        const contenders = (await client.getAll().prefix(queuePrefix('queued-loss')).exec()).kvs;
        expect(contenders).toHaveLength(2);
        const ownerLease = (await client.get('queued-loss').exec()).kvs[0].lease;
        queuedLease = contenders.find(kv => kv.lease !== ownerLease)!.lease;
      });
      await client.leaseClient.leaseRevoke({ ID: queuedLease });
      await expect(waiting).rejects.toBeInstanceOf(EtcdLeaseInvalidError);
    } finally {
      await waiting.catch(() => undefined);
      await holder.unlock();
    }
  });
});
