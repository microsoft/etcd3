import { expect } from 'chai';

import { Etcd3 } from '../src';
import { getHosts } from './util';

describe('connection pool', () => {
  let client: Etcd3;

  beforeEach(() => {
    client = new Etcd3({ hosts: getHosts() });
    return Promise.all([
      client.put('foo1').value('bar1'),
      client.put('foo2').value('bar2'),
      client.put('foo3').value('{"value":"bar3"}'),
      client.put('baz').value('bar5'),
    ]);
  });

  afterEach(() => client.delete().all());

  it('lists all values', async () => {
    expect(await client.getAll().strings()).to.containSubset(['bar1', 'bar2', 'bar5']);
  });

  it('gets single keys with various encoding', async () => {
    expect(await client.get('foo1').string()).to.equal('bar1');
    expect(await client.get('foo2').buffer()).to.deep.equal(Buffer.from('bar2'));
    expect(await client.get('foo3').json()).to.deep.equal({ value: 'bar3' });
    expect(await client.get('wut').string()).to.be.null;
  });

  it('queries prefixes', async () => {
    expect(await client.getAll().prefix('foo').strings())
      .to.have.members(['bar1', 'bar2', '{"value":"bar3"}']);
  });

  it('gets keys', async () => {
    expect(await client.getAll().keys()).to.have.members(['foo1', 'foo2', 'foo3', 'baz']);
  });
});
