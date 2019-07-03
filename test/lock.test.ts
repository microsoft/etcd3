import { expect } from 'chai';

import { Etcd3, EtcdLockFailedError } from '../src';
import { createTestClientAndKeys, tearDownTestClient } from './util';

describe('lock()', () => {
  let client: Etcd3;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => await tearDownTestClient(client));

  const assertCantLock = () => {
    return expect(client.lock('resource').acquire()).to.eventually.be.rejectedWith(
      EtcdLockFailedError,
    );
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
    const lock = await client
      .lock('resource')
      .ttl(10)
      .acquire();
    await lock.release();
  });

  it('disallows setting TTL while lock is acquired', async () => {
    const lock = await client.lock('resource').acquire();
    expect(() => lock.ttl(10)).to.throw(/Cannot set a lock TTL after acquiring the lock/);
    await lock.release();
  });

  it('gets the lock lease ID', async () => {
    const lock = await client.lock('resource');
    expect(await lock.leaseId()).to.equal(null, 'expected no lease initially');
    await lock.acquire();
    const leaseId = await lock.leaseId();
    expect(leaseId).to.be.a('string');
    expect((await client.get('resource').exec()).kvs[0].lease).to.equal(leaseId);
    await lock.release();
  });
});
