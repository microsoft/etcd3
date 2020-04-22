import { expect } from 'chai';

import { Etcd3 } from '../src';
import { createTestClientAndKeys, tearDownTestClient } from './util';

describe('transactions', () => {
  let client: Etcd3;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => await tearDownTestClient(client));

  it('runs a simple if', async () => {
    await client.if('foo1', 'Value', '==', 'bar1').then(client.put('foo1').value('bar2')).commit();

    expect(await client.get('foo1').string()).to.equal('bar2');
  });

  it('runs consequents', async () => {
    await client
      .if('foo1', 'Value', '==', 'bar1')
      .then(client.put('foo1').value('bar2'))
      .else(client.put('foo1').value('bar3'))
      .commit();

    expect(await client.get('foo1').string()).to.equal('bar2');
  });

  it('runs multiple clauses and consequents', async () => {
    const result = await client
      .if('foo1', 'Value', '==', 'bar1')
      .and('foo2', 'Value', '==', 'wut')
      .then(client.put('foo1').value('bar2'))
      .else(client.put('foo1').value('bar3'), client.get('foo2'))
      .commit();

    expect(result.responses[1].response_range.kvs[0].value.toString()).to.equal('bar2');
    expect(await client.get('foo1').string()).to.equal('bar3');
  });
});
