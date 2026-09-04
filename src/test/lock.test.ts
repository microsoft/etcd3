/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Etcd3, EtcdLockFailedError } from '..';
import { createTestClientAndKeys, tearDownTestClient } from './util';

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
