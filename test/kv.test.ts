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

  describe('get() / getAll()', () => {
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

    it('counts', async () => {
      expect(await client.getAll().count()).to.equal(4);
    });

    it('sorts', async () => {
      expect(await client.getAll()
        .prefix('foo')
        .sort('key', 'asc')
        .limit(2)
        .keys(),
      ).to.deep.equal(['foo1', 'foo2']);

      expect(await client.getAll()
        .prefix('foo')
        .sort('key', 'desc')
        .limit(2)
        .keys(),
      ).to.deep.equal(['foo3', 'foo2']);
    });
  });

  describe('delete()', () => {
    it('deletes all', async () => {
      await client.delete().all();
      expect(await client.getAll().count()).to.equal(0);
    });

    it('deletes prefix', async () => {
      await client.delete().prefix('foo');
      expect(await client.getAll().keys()).to.deep.equal(['baz']);
    });

    it('gets previous', async () => {
      expect(await client.delete().key('foo1').getPrevious()).to.containSubset([
        {
          key: new Buffer('foo1'),
          value: new Buffer('bar1'),
        },
      ]);
    });

    describe('put()', () => {
      it('allows touching key revisions', async () => {
        const original = (await client.get('foo1').exec()).kvs[0].mod_revision;
        await client.put('foo1').touch();
        const updated = (await client.get('foo1').exec()).kvs[0].mod_revision;
        expect(Number(updated)).to.be.greaterThan(Number(original));
      });

      it('updates key values', async () => {
        await client.put('foo1').value('updated');
        expect(await client.get('foo1').string()).to.equal('updated');
      });

      it('includes previous values', async () => {
        expect(await client.put('foo1').value('updated').getPrevious()).to.containSubset({
            key: new Buffer('foo1'),
            value: new Buffer('bar1'),
        });
      });
    });
  });
});
