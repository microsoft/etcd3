import { expect } from 'chai';
import * as sinon from 'sinon';

import {
  Etcd3,
  EtcdLeaseInvalidError,
  EtcdLockFailedError,
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

  afterEach(async () => {
    await client.delete().all();
    client.close();
    badClient.close();
  });

  it('allows mocking', async () => {
    const mock = client.mock({
      exec: sinon.stub(),
      getConnection: sinon.stub(),
    });

    mock.exec.resolves({ kvs: [] });
    expect(await client.get('foo1').string()).to.be.null;
    expect(mock.exec.calledWith('KV', 'range')).to.be.true;
    client.unmock();
    expect(await client.get('foo1').string()).to.equal('bar1');
  });

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

    it('queries prefixes', async () => {
      expect(await client.getAll().prefix('fo').strings()).to.deep.equal({
        o1: 'bar1',
        o2: 'bar2',
        o3: '{"value":"bar3"}',
      });
    });

    it('supports wide utf8 characters in prefixes', async () => {
      // These characters are >16 bits, if they're sliced in the wrong order
      // (based on string rather than byte length) the prefix can get truncated.
      await client.put('❤️/💔').value('heyo!');
      expect(await client.getAll().prefix('❤️/')).to.deep.equal({
        '💔': 'heyo!',
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
      expect(await client.getAll()
        .prefix('foo')
        .sort('key', 'asc')
        .limit(2)
        .keys(),
      ).to.deep.equal(['1', '2']);

      expect(await client.getAll()
        .prefix('foo')
        .sort('key', 'desc')
        .limit(2)
        .keys(),
      ).to.deep.equal(['3', '2']);
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
      expect((await client.get('leased').exec()).kvs[0].lease).to.equal(await lease.grant());
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

    describe('if()', () => {
      it('runs a simple if', async () => {
        await client.if('foo1', 'value', '==', 'bar1')
          .then(client.put('foo1').value('bar2'))
          .commit();

        expect(await client.get('foo1').string()).to.equal('bar2');
      });

      it('runs consequents', async () => {
        await client.if('foo1', 'value', '==', 'bar1')
          .then(client.put('foo1').value('bar2'))
          .else(client.put('foo1').value('bar3'))
          .commit();

        expect(await client.get('foo1').string()).to.equal('bar2');
      });

      it('runs multiple clauses and consequents', async () => {
        const result = await client.if('foo1', 'value', '==', 'bar1')
          .and('foo2', 'value', '==', 'wut')
          .then(client.put('foo1').value('bar2'))
          .else(client.put('foo1').value('bar3'), client.get('foo2'))
          .commit();

        expect(result.responses[1].response_range.kvs[0].value.toString())
          .to.equal('bar2');
        expect(await client.get('foo1').string()).to.equal('bar3');
      });
    });

    describe('lock()', () => {
      const assertCantLock = () => {
        return client.lock('resource')
          .acquire()
          .then(() => { throw new Error('expected to throw'); })
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
  });
});
