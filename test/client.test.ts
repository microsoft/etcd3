import { expect } from 'chai';
import * as sinon from 'sinon';

import {
  Etcd3,
  EtcdAuthenticationFailedError,
  EtcdLeaseInvalidError,
  EtcdLockFailedError,
  EtcdPermissionDeniedError,
  EtcdRoleExistsError,
  EtcdRoleNotFoundError,
  EtcdRoleNotGrantedError,
  EtcdUserExistsError,
  EtcdUserNotFoundError,
  GRPCConnectFailedError,
  Lease,
  Namespace,
  Role,
} from '../src';
import { getOptions } from './util';

function expectReject(promise: Promise<any>, err: { new (message: string): Error }) {
  return promise
    .then(() => { throw new Error('expected to reject'); })
    .catch(actualErr => {
      if (!(actualErr instanceof err)) {
        console.error(actualErr.stack);
        expect(actualErr).to.be.an.instanceof(err);
      }
    });
}

function wipeAll(things: Promise<{ delete(): any }[]>) {
  return things.then(items => Promise.all(items.map(item => item.delete())));
}

describe('client', () => {
  let client: Etcd3;
  let badClient: Etcd3;

  beforeEach(() => {
    client = new Etcd3(getOptions());
    badClient = new Etcd3(getOptions({ hosts: '127.0.0.1:1' }));
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

  describe('namespacing', () => {
    let ns: Namespace;
    beforeEach(() => ns = client.namespace('user1/'));

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
      await ns.if('foo1', 'Value', '==', 'potatoes')
        .then(ns.put('foo1').value('tomatoes'))
        .commit();

      await assertEqualInNamespace('foo1', 'tomatoes');
    });
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
      expect(await client.getAll()
        .prefix('foo')
        .sort('Key', 'Ascend')
        .limit(2)
        .keys(),
      ).to.deep.equal(['foo1', 'foo2']);

      expect(await client.getAll()
        .prefix('foo')
        .sort('Key', 'Descend')
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
        await client.if('foo1', 'Value', '==', 'bar1')
          .then(client.put('foo1').value('bar2'))
          .commit();

        expect(await client.get('foo1').string()).to.equal('bar2');
      });

      it('runs consequents', async () => {
        await client.if('foo1', 'Value', '==', 'bar1')
          .then(client.put('foo1').value('bar2'))
          .else(client.put('foo1').value('bar3'))
          .commit();

        expect(await client.get('foo1').string()).to.equal('bar2');
      });

      it('runs multiple clauses and consequents', async () => {
        const result = await client.if('foo1', 'Value', '==', 'bar1')
          .and('foo2', 'Value', '==', 'wut')
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

  describe('roles', () => {
    afterEach(() => wipeAll(client.getRoles()));

    const expectRoles = async (expected: string[]) => {
      const list = await client.getRoles();
      expect(list.map(r => r.name)).to.deep.equal(expected);
    };

    it('create and deletes', async () => {
      const fooRole = await client.role('foo').create();
      await expectRoles(['foo']);
      await fooRole.delete();
      await expectRoles([]);
    });

    it('throws on existing roles', async () => {
      await client.role('foo').create();
      await expectReject(client.role('foo').create(), EtcdRoleExistsError);
    });

    it('throws on deleting a non-existent role', async () => {
      await expectReject(client.role('foo').delete(), EtcdRoleNotFoundError);
    });

    it('throws on granting permission to a non-existent role', async () => {
      await expectReject(
        client.role('foo').grant({
          permission: 'Read',
          range: client.range({ prefix: '111' }),
        }),
        EtcdRoleNotFoundError,
      );
    });

    it('round trips permission grants', async () => {
      const fooRole = await client.role('foo').create();
      await fooRole.grant({
        permission: 'Read',
        range: client.range({ prefix: '111' }),
      });

      const perms = await fooRole.permissions();
      expect(perms).to.containSubset([
        {
          permission: 'Read',
          range: client.range({ prefix: '111' }),
        },
      ]);

      await fooRole.revoke(perms[0]);
      expect(await fooRole.permissions()).to.have.length(0);
    });
  });

  describe('users', () => {
    let fooRole: Role;
    beforeEach(async () => {
      fooRole = client.role('foo');
      await fooRole.create();
    });

    afterEach(async () => {
      await fooRole.delete();
      await wipeAll(client.getUsers());
    });

    it('creates users', async () => {
      expect(await client.getUsers()).to.have.lengthOf(0);
      await client.user('connor').create('password');
      expect(await client.getUsers()).to.containSubset([{ name: 'connor' }]);
    });

    it('throws on existing users', async () => {
      await client.user('connor').create('password');
      await expectReject(client.user('connor').create('password'), EtcdUserExistsError);
    });

    it('throws on regranting the same role multiple times', async () => {
      const user = await client.user('connor').create('password');
      await expectReject(user.removeRole(fooRole), EtcdRoleNotGrantedError);
    });

    it('throws on granting a non-existent role', async () => {
      const user = await client.user('connor').create('password');
      await expectReject(user.addRole('wut'), EtcdRoleNotFoundError);
    });

    it('throws on deleting a non-existent user', async () => {
      await expectReject(client.user('connor').delete(), EtcdUserNotFoundError);
    });

    it('round trips roles', async () => {
      const user = await client.user('connor').create('password');
      await user.addRole(fooRole);
      expect(await user.roles()).to.containSubset([{ name: 'foo' }]);
      await user.removeRole(fooRole);
      expect(await user.roles()).to.have.lengthOf(0);
    });
  });

  describe('password auth', () => {
    beforeEach(async () => {
      await wipeAll(client.getUsers());
      await wipeAll(client.getRoles());

      // We need to set up a root user and root role first, otherwise etcd
      // will yell at us.
      const rootUser = await client.user('root').create('password');
      rootUser.addRole('root');

      await client.user('connor').create('password');

      const normalRole = await client.role('rw_prefix_f').create();
      await normalRole.grant({
        permission: 'Readwrite',
        range: client.range({ prefix: 'f' }),
      });
      await normalRole.addUser('connor');
      await client.auth.authEnable();
    });

    afterEach(async () => {
      const rootClient = new Etcd3(getOptions({
        auth: {
          username: 'root',
          password: 'password',
        },
      }));

      await rootClient.auth.authDisable();
      rootClient.close();

      await wipeAll(client.getUsers());
      await wipeAll(client.getRoles());
    });

    it('allows authentication using the correct credentials', async () => {
      const authedClient = new Etcd3(getOptions({
        auth: {
          username: 'connor',
          password: 'password',
        },
      }));

      await authedClient.put('foo').value('bar');
      authedClient.close();
    });

    it('rejects modifying a key the client has no access to', async () => {
      const authedClient = new Etcd3(getOptions({
        auth: {
          username: 'connor',
          password: 'password',
        },
      }));

      await expectReject(
        authedClient.put('wut').value('bar').exec(),
        EtcdPermissionDeniedError,
      );

      authedClient.close();
    });

    it('throws when using incorrect credentials', async () => {
      const authedClient = new Etcd3(getOptions({
        auth: {
          username: 'connor',
          password: 'bad password',
        },
      }));

      await expectReject(
        authedClient.put('foo').value('bar').exec(),
        EtcdAuthenticationFailedError,
      );

      authedClient.close();
    });
  });
});
