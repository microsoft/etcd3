import { expect } from 'chai';
import * as sinon from 'sinon';

import {
  Etcd3,
  EtcdLeaseInvalidError,
  GRPCConnectFailedError,
  Lease,
} from '../src';
import { getHosts } from './util';

describe('connection pool', () => {
  let client: Etcd3;
  let badClient: Etcd3;

  beforeEach(() => {
    client = new Etcd3({ hosts: getHosts() });
    badClient = new Etcd3({ hosts: '127.0.0.1:1' });
    return Promise.all([
      client.put('foo1').value('bar1'),
      client.put('foo2').value('bar2'),
      client.put('foo3').value('{"value":"bar3"}'),
      client.put('baz').value('bar5'),
    ]);
  });

  afterEach(() => {
    client.delete().all();
    client.close();
    badClient.close();
  });

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

  describe('lease()', () => {
    let lease: Lease;

    const watchEmission = (event: string): { data: any, fired: boolean } => {
      const output = { data: null, fired: false };
      lease.once(event, (data: any) => {
        output.data = data;
        output.fired = true;
      });

      return output;
    };

    const onEvent = (event: string): Promise<any> => {
      return new Promise(resolve => lease.once(event, (data: any) => resolve(data)));
    };

    afterEach(async () => {
      if (lease && !lease.revoked()) {
        await lease.revoke();
      }
    });

    it('throws if trying to use too short of a ttl', () => {
      expect(() => client.lease(0)).to.throw(/must be at least 1 second/);
    });

    it('reports a loss and errors if the client is invalid', async () => {
      lease = badClient.lease(1);
      const err = await onEvent('lost');
      expect(err).to.be.an.instanceof(GRPCConnectFailedError);
      await lease.grant()
        .then(() => { throw new Error('expected to reject'); })
        .catch(err2 => expect(err2).to.equal(err));
    });

    it('provides basic lease lifecycle', async () => {
      lease = client.lease(100);
      await lease.put('leased').value('foo');
      expect((await client.get('leased')).kvs[0].lease).to.equal(await lease.grant());
      await lease.revoke();
      expect(await client.get('leased').buffer()).to.be.null;
    });

    it('runs immediate keepalives', async () => {
      lease = client.lease(100);
      expect(await lease.keepaliveOnce()).to.containSubset({
        ID: await lease.grant(),
        TTL: '100',
      });
      await lease.keepaliveOnce();
    });

    it('emits a lost event if the lease is invalidated', async () => {
      lease = client.lease(100);
      let err: Error;
      lease.on('lost', e => err = e);
      expect(lease.revoked()).to.be.false;
      await client.leaseClient.leaseRevoke({ ID: await lease.grant() });

      await lease.keepaliveOnce()
        .then(() => { throw new Error('expected to reject'); })
        .catch(err2 => {
          expect(err2).to.equal(err);
          expect(err2).to.be.an.instanceof(EtcdLeaseInvalidError);
          expect(lease.revoked()).to.be.true;
        });
    });

    describe('crons', () => {
      let clock: sinon.SinonFakeTimers;

      beforeEach(async () => {
        clock = sinon.useFakeTimers();
        lease = client.lease(60);
        await onEvent('keepaliveEstablished');
      });

      afterEach(() => clock.restore());

      it('touches the lease ttl at the correct interval', async () => {
        const kaFired = watchEmission('keepaliveFired');
        clock.tick(19999);
        expect(kaFired.fired).to.be.false;
        clock.tick(1);
        expect(kaFired.fired).to.be.true;

        const res = await onEvent('keepaliveSucceeded');
        expect(res.TTL).to.equal('60');
      });

      it('tears down if the lease gets revoked', async () => {
        await client.leaseClient.leaseRevoke({ ID: await lease.grant() });
        clock.tick(20000);
        expect(await onEvent('lost')).to.be.an.instanceof(EtcdLeaseInvalidError);
        expect(lease.revoked()).to.be.true;
      });
    });
  });
});
