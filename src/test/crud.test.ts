/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';

import { Etcd3 } from '..';
import { createTestClientAndKeys, tearDownTestClient } from './util';

describe('crud', () => {
  let client: Etcd3;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => await tearDownTestClient(client));

  describe('get() / getAll()', () => {
    it('lists all values', async () => {
      expect(await client.getAll().strings()).to.deep.equal({
        foo1: 'bar1',
        foo2: 'bar2',
        foo3: '{"value":"bar3"}',
        baz: 'bar5',
      });
    });

    it('gets single keys with various encoding', async () => {
      expect(await client.get('foo1').string()).to.equal('bar1');
      expect(await client.get('foo2').buffer()).to.deep.equal(Buffer.from('bar2'));
      expect(await client.get('foo3').json()).to.deep.equal({ value: 'bar3' });
      expect(await client.get('wut').string()).to.be.null;
    });

    it('gets whether keys exist', async () => {
      expect(await client.get('foo1').exists()).to.be.true;
      expect(await client.get('wut').exists()).to.be.false;
    });

    it('queries prefixes', async () => {
      expect(await client.getAll().prefix('fo').strings()).to.deep.equal({
        foo1: 'bar1',
        foo2: 'bar2',
        foo3: '{"value":"bar3"}',
      });
    });

    it('gets keys', async () => {
      expect(await client.getAll().keys()).to.have.members(['foo1', 'foo2', 'foo3', 'baz']);
      expect(await client.getAll().keyBuffers()).to.have.deep.members([
        Buffer.from('foo1'),
        Buffer.from('foo2'),
        Buffer.from('foo3'),
        Buffer.from('baz'),
      ]);
    });

    it('counts', async () => {
      expect(await client.getAll().count()).to.equal(4);
    });

    it('sorts', async () => {
      expect(
        await client.getAll().prefix('foo').sort('Key', 'Ascend').limit(2).keys(),
      ).to.deep.equal(['foo1', 'foo2']);

      expect(
        await client.getAll().prefix('foo').sort('Key', 'Descend').limit(2).keys(),
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
          key: Buffer.from('foo1'),
          value: Buffer.from('bar1'),
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
          key: Buffer.from('foo1'),
          value: Buffer.from('bar1'),
        });
      });
    });
  });
});
