import { expect } from 'chai';

import { Etcd3, EtcdLockFailedError } from '../src';
import { createTestClientAndKeys, tearDownTestClient } from './util';

describe('lock()', () => {
  let client: Etcd3;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => await tearDownTestClient(client));

  const assertCantLock = () => {
    return client
      .lock('resource')
      .acquire()
      .then(() => {
        throw new Error('expected to throw');
      })
      .catch(err => expect(err).to.be.an.instanceof(EtcdLockFailedError));
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
});
