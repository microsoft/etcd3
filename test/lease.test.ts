import { expect } from 'chai';
import * as sinon from 'sinon';

import { Etcd3, EtcdLeaseInvalidError, GRPCConnectFailedError, Lease } from '../src';
import { onceEvent } from '../src/util';
import { createTestClientAndKeys, getOptions, proxy, tearDownTestClient } from './util';

describe('lease()', () => {
  let client: Etcd3;
  let lease: Lease;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => await tearDownTestClient(client));

  const watchEmission = (event: string): { data: any; fired: boolean } => {
    const output = { data: null, fired: false };
    lease.once(event, (data: any) => {
      output.data = data;
      output.fired = true;
    });

    return output;
  };

  afterEach(async () => {
    if (lease && !lease.revoked()) {
      await lease.revoke();
    }
  });

  it('throws if trying to use too short of a ttl, or an undefined ttl', () => {
    expect(() => client.lease(0)).to.throw(/must be at least 1 second/);
    expect(() => (<any>client.lease)()).to.throw(/must be at least 1 second/);
  });

  it('reports a loss and errors if the client is invalid', async () => {
    const badClient = new Etcd3(getOptions({ hosts: '127.0.0.1:1' }));
    lease = badClient.lease(1);
    const err = await onceEvent(lease, 'lost');
    expect(err).to.be.an.instanceof(GRPCConnectFailedError);
    await lease
      .grant()
      .then(() => {
        throw new Error('expected to reject');
      })
      .catch(err2 => expect(err2).to.equal(err));
    badClient.close();
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

  it('is resilient to network interruptions', async () => {
    await proxy.activate();
    const proxiedClient = new Etcd3(getOptions());

    lease = proxiedClient.lease(100);
    await lease.grant();
    proxy.pause();
    await onceEvent(lease, 'keepaliveFailed');
    proxy.resume();
    await onceEvent(lease, 'keepaliveSucceeded');
    await lease.revoke();

    proxiedClient.close();
    proxy.deactivate();
  });

  it('marks leases as failed if the server is not contacted for a while', async () => {
    await proxy.activate();
    const proxiedClient = new Etcd3(getOptions());

    lease = proxiedClient.lease(1);
    await lease.grant();
    proxy.pause();
    (<any>lease).lastKeepAlive = Date.now() - 2000; // speed things up a little
    const err = await onceEvent(lease, 'lost');
    expect(err.message).to.match(/our lease has expired/);
    proxiedClient.close();
    proxy.deactivate();
  });

  it('emits a lost event if the lease is invalidated', async () => {
    lease = client.lease(100);
    let err: Error;
    lease.on('lost', e => {
      expect(lease.revoked()).to.be.true;
      err = e;
    });

    expect(lease.revoked()).to.be.false;
    await client.leaseClient.leaseRevoke({ ID: await lease.grant() });

    await lease
      .keepaliveOnce()
      .then(() => {
        throw new Error('expected to reject');
      })
      .catch(err2 => {
        expect(err2).to.equal(err);
        expect(err2).to.be.an.instanceof(EtcdLeaseInvalidError);
        expect(lease.revoked()).to.be.true;
      });
  });

  it('emits a loss if the touched key is lost', async () => {
    (<any>lease).leaseID = Promise.resolve('123456789');
    const lost = onceEvent(lease, 'lost');

    try {
      await lease.put('foo').value('bar');
    } catch (e) {
      expect(e).to.be.an.instanceof(EtcdLeaseInvalidError);
      expect(e).to.equal(await lost);
      expect(lease.revoked()).to.be.true;
    }
  });

  describe('crons', () => {
    let clock: sinon.SinonFakeTimers;

    beforeEach(async () => {
      clock = sinon.useFakeTimers();
      lease = client.lease(60);
      await onceEvent(lease, 'keepaliveEstablished');
    });

    afterEach(() => clock.restore());

    it('touches the lease ttl at the correct interval', async () => {
      const kaFired = watchEmission('keepaliveFired');
      clock.tick(19999);
      expect(kaFired.fired).to.be.false;
      clock.tick(1);
      expect(kaFired.fired).to.be.true;

      const res = await onceEvent(lease, 'keepaliveSucceeded');
      expect(res.TTL).to.equal('60');
    });

    it('stops touching the lease if released passively', async () => {
      const kaFired = watchEmission('keepaliveFired');
      lease.release();
      clock.tick(20000);
      expect(kaFired.fired).to.be.false;
    });

    it('tears down if the lease gets revoked', async () => {
      await client.leaseClient.leaseRevoke({ ID: await lease.grant() });
      clock.tick(20000);
      expect(await onceEvent(lease, 'lost')).to.be.an.instanceof(EtcdLeaseInvalidError);
      expect(lease.revoked()).to.be.true;
    });
  });
});
