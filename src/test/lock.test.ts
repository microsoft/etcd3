/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Etcd3, EtcdLockFailedError } from '../index.js';
import { createTestClientAndKeys, tearDownTestClient } from './util.js';

describe('lock()', () => {
  let client: Etcd3;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => await tearDownTestClient(client));

  const assertCantLock = () => {
    return expect(client.lock('resource').acquire()).rejects.toThrow(EtcdLockFailedError);
  };

  const assertAbleToLock = async () => {
    const lock = client.lock('resource');
    await lock.acquire();
    await lock.release();
  };

  it('locks exclusively around a resource', async () => {
    const lock1 = client.lock('resource');
    await lock1.acquire();

    await assertCantLock();
    await lock1.release();

    await assertAbleToLock();
  });

  it('rejects acquiring an already acquired lock without losing its lease', async () => {
    const lock = client.lock('resource');
    await lock.acquire();

    await expect(lock.acquire()).rejects.toThrow(EtcdLockFailedError);
    await lock.release();

    await assertAbleToLock();
  });

  it('allows a released lock to be acquired again', async () => {
    const lock = client.lock('resource');
    await lock.acquire();
    await lock.release();
    await lock.acquire();
    await lock.release();
  });

  it('releases acquired locks when disposed and tolerates explicit release', async () => {
    const error = new Error('operation failed');
    const lock = await client.lock('resource').acquire();

    await expect(
      (async () => {
        await using disposableLock = lock;
        void disposableLock;
        throw error;
      })(),
    ).rejects.toBe(error);

    await assertAbleToLock();
    await expect(lock[Symbol.asyncDispose]()).resolves.toBeUndefined();

    const manuallyReleased = await client.lock('resource').acquire();
    await manuallyReleased.release();
    await expect(manuallyReleased[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it('releases and reacquires a lock after its acquire deadline has expired', async () => {
    const deadline = new Date(Date.now() + 2_000);
    const lock = client.lock('resource').options({ deadline });
    await lock.acquire();

    await new Promise(resolve => setTimeout(resolve, deadline.getTime() - Date.now() + 100));
    await lock.release();

    await assertAbleToLock();
  });

  it('revokes the lease without an expired acquire deadline when acquiring fails', async () => {
    const transactionError = new Error('transaction failed');
    const callOptions = { deadline: new Date(0), waitForReady: true };
    const exec = vi.fn((service: string, method: string, _: unknown, options?: unknown) => {
      if (service === 'Lease' && method === 'leaseGrant') {
        return Promise.resolve({ ID: '123', TTL: '30' });
      }

      if (service === 'KV' && method === 'txn') {
        return Promise.reject(transactionError);
      }

      if (service === 'Lease' && method === 'leaseRevoke') {
        expect(options).toEqual({ waitForReady: true });
        return Promise.resolve({});
      }

      throw new Error(`Unexpected call: ${service}.${method}`);
    });
    client.mock({ exec: exec as any });

    try {
      await expect(client.lock('resource').options(callOptions).acquire()).rejects.toBe(
        transactionError,
      );
      const leaseGrantCall = exec.mock.calls.find(
        ([service, method]) => service === 'Lease' && method === 'leaseGrant',
      );
      expect(leaseGrantCall?.[3]).toBe(callOptions);
      const transactionCall = exec.mock.calls.find(
        ([service, method]) => service === 'KV' && method === 'txn',
      );
      expect(transactionCall?.[3]).toBe(callOptions);
      expect(exec).toHaveBeenCalledWith(
        'Lease',
        'leaseRevoke',
        { ID: '123' },
        {
          waitForReady: true,
        },
      );
    } finally {
      client.unmock();
    }
  });

  it('reports both failures when failed-acquire cleanup cannot revoke the lease', async () => {
    const transactionError = new Error('transaction failed');
    const cleanupError = new Error('cleanup failed');
    const exec = vi.fn((service: string, method: string) => {
      if (service === 'Lease' && method === 'leaseGrant') {
        return Promise.resolve({ ID: '123', TTL: '30' });
      }

      if (service === 'KV' && method === 'txn') {
        return Promise.reject(transactionError);
      }

      if (service === 'Lease' && method === 'leaseRevoke') {
        return Promise.reject(cleanupError);
      }

      throw new Error(`Unexpected call: ${service}.${method}`);
    });
    client.mock({ exec: exec as any });

    try {
      const error = await client
        .lock('resource')
        .options({ deadline: new Date(0) })
        .acquire()
        .catch(error => error);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([transactionError, cleanupError]);
    } finally {
      client.unmock();
    }
  });

  it('provides locking around functions', async () => {
    await client.lock('resource').do(assertCantLock);
    await assertAbleToLock();
  });

  it('allows setting lock TTL before acquiring', async () => {
    const lock = await client.lock('resource').ttl(10).acquire();
    await lock.release();
  });

  it('disallows setting TTL while lock is acquired', async () => {
    const lock = await client.lock('resource').acquire();
    expect(() => lock.ttl(10)).toThrow(/Cannot set a lock TTL after acquiring the lock/);
    await lock.release();
  });

  it('gets the lock lease ID', async () => {
    const lock = await client.lock('resource');
    expect(await lock.leaseId(), 'expected no lease initially').toBeNull();
    await lock.acquire();
    const leaseId = await lock.leaseId();
    expect(leaseId).toBeTypeOf('string');
    expect((await client.get('resource').exec()).kvs[0].lease).toBe(leaseId);
    await lock.release();
  });

  it('exposes its granted lease ID while the owner transaction is pending', async () => {
    const transactionError = new Error('transaction failed after observing lease');
    let rejectTransaction!: (error: Error) => void;
    const transaction = new Promise<never>((_, reject) => {
      rejectTransaction = reject;
    });
    const exec = vi.fn((service: string, method: string) => {
      if (service === 'Lease' && method === 'leaseGrant') {
        return Promise.resolve({ ID: 'pending-lease', TTL: '30' });
      }
      if (service === 'KV' && method === 'txn') {
        return transaction;
      }
      if (service === 'Lease' && method === 'leaseRevoke') {
        return Promise.resolve({});
      }
      throw new Error(`Unexpected call: ${service}.${method}`);
    });
    client.mock({ exec: exec as any });

    try {
      const lock = client.lock('pending-resource');
      const acquisition = lock.acquire();
      await expect(lock.leaseId()).resolves.toBe('pending-lease');
      expect(
        exec.mock.calls.some(([service, method]) => service === 'KV' && method === 'txn'),
      ).toBe(true);

      rejectTransaction(transactionError);
      await expect(acquisition).rejects.toBe(transactionError);
      await expect(lock.leaseId()).resolves.toBeNull();
    } finally {
      client.unmock();
    }
  });
});
