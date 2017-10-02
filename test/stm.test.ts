import { expect } from 'chai';

import { Etcd3, STMConflictError } from '../src';
import { createTestClientAndKeys, tearDownTestClient } from './util';

describe('stm()', () => {
  let client: Etcd3;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => await tearDownTestClient(client));

  it('executes empty transactions', async () => {
    expect(await client.stm().transact(() => 'foo')).to.equal('foo');
  });

  it('runs transactions when all is good', async () => {
    await client.stm().transact(async tx => {
      const value = await tx.get('foo1');
      await tx.put('foo1').value(value!.repeat(3));
      expect(await client.get('foo1')).to.equal('bar1'); // should not have changed yet
    });

    expect(await client.get('foo1')).to.equal('bar1bar1bar1');
  });

  it('retries transactons', async () => {
    // 1. get foo1
    // 2. outside the transaction, set it to something else
    // 3. try to write it and fail
    // 4. get foo1, this time write it succesfully to what was set before

    let tries = 0;
    await client.stm().transact(async tx => {
      const value = await tx.get('foo1');
      if (tries++ === 0) {
        await client.put('foo1').value('lol');
      }

      await tx.put('foo1').value(value!.repeat(3));
    });

    expect(await client.get('foo1')).to.equal('lollollol');
    expect(tries).to.equal(2);
  });

  it('aborts transactions on continous failure', async () => {
    await client
      .stm()
      .transact(async tx => {
        const value = await tx.get('foo1');
        await client.put('foo1').value('lol');
        await tx.put('foo1').value(value!.repeat(3));
      })
      .then(() => {
        throw new Error('expected to throw');
      })
      .catch(err => expect(err).to.be.an.instanceof(STMConflictError));
  });
});
