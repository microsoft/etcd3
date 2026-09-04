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

  it('revokes the lease when acquiring fails after it is granted', async () => {
    const transactionError = new Error('transaction failed');
    const exec = vi.fn((service: string, method: string) => {
      if (service === 'Lease' && method === 'leaseGrant') {
        return Promise.resolve({ ID: '123', TTL: '30' });
      }

      if (service === 'KV' && method === 'txn') {
        return Promise.reject(transactionError);
      }

      if (service === 'Lease' && method === 'leaseRevoke') {
        return Promise.resolve({});
      }

      throw new Error(`Unexpected call: ${service}.${method}`);
    });
    client.mock({ exec: exec as any });

    try {
      await expect(client.lock('resource').acquire()).rejects.toBe(transactionError);
      expect(exec).toHaveBeenCalledWith('Lease', 'leaseRevoke', { ID: '123' });
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
});
