import { expect } from 'chai';

import { Etcd3, Namespace } from '../src';
import { createTestClientAndKeys, tearDownTestClient } from './util';

describe('namespacing', () => {
  let client: Etcd3;
  let ns: Namespace;

  beforeEach(async () => {
    client = await createTestClientAndKeys();
    ns = client.namespace('user1/');
  });

  afterEach(async () => await tearDownTestClient(client));

  const assertEqualInNamespace = async (key: string, value: string) => {
    expect(await ns.get(key)).to.equal(value);
    expect(await client.get(`user1/${key}`)).to.equal(value);
  };

  it('puts and gets values in the namespace', async () => {
    await ns.put('foo').value('');
    await assertEqualInNamespace('foo', '');
    expect(await ns.getAll().strings()).to.deep.equal({ foo: '' });
  });

  it('deletes values in the namespace', async () => {
    await ns.put('foo1').value('');
    await ns.put('foo2').value('');

    await ns.delete().key('foo1');
    expect(await ns.getAll().strings()).to.deep.equal({ foo2: '' });
    await ns.delete().all();

    expect(await ns.getAll().strings()).to.deep.equal({});
    expect(await client.getAll().keys()).to.have.length.greaterThan(0);
  });

  it('contains leases in the namespace', async () => {
    const lease = ns.lease(100);
    await lease.put('leased').value('');
    await assertEqualInNamespace('leased', '');
    await lease.revoke();
  });

  it('contains locks in the namespace', async () => {
    const lock = ns.lock('mylock');
    await lock.acquire();
    expect(await ns.get('mylock')).to.not.be.null;
    expect(await client.get('user1/mylock')).to.not.be.null;
    await lock.release();
  });

  it('runs a simple if', async () => {
    await ns.put('foo1').value('potatoes');
    await ns
      .if('foo1', 'Value', '==', 'potatoes')
      .then(ns.put('foo1').value('tomatoes'))
      .commit();

    await assertEqualInNamespace('foo1', 'tomatoes');
  });
});
