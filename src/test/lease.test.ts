/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Etcd3, EtcdLeaseInvalidError } from '../index.js';
import type { Lease } from '../index.js';
import { onceEvent } from '../util.js';
import {
  createTestClientAndKeys,
  getOptions,
  proxy,
  tearDownTestClient,
  TrafficDirection,
  unmockedDelay,
} from './util.js';
import { GRPCUnavailableError } from '../errors.js';

describe('lease()', () => {
  let client: Etcd3;
  let lease: Lease;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => {
    if (lease && !lease.revoked()) {
      await lease.revoke();
    }

    await tearDownTestClient(client);

    vi.useRealTimers();
  });

  const watchEmission = (event: string): { data: any; fired: boolean } => {
    const output = { data: null, fired: false };
    lease.once(event, (data: any) => {
      output.data = data;
      output.fired = true;
    });

    return output;
  };

  it('throws if trying to use too short of a ttl, or an undefined ttl', () => {
    expect(() => client.lease(0)).toThrow(/must be at least 1 second/);
    expect(() => (client.lease as any)()).toThrow(/must be at least 1 second/);
  });

  it('reports a loss and errors if the client is invalid', async () => {
    const badClient = new Etcd3(getOptions({ hosts: '127.0.0.1:1' }));
    lease = badClient.lease(1);
    const err = await onceEvent(lease, 'lost');
    expect(err).toBeInstanceOf(GRPCUnavailableError);
    await lease
      .grant()
      .then(() => {
        throw new Error('expected to reject');
      })
      .catch(err2 => expect(err2).toBe(err));
    badClient.close();
  });

  it('provides basic lease lifecycle', async () => {
    lease = client.lease(100);
    await lease.put('leased').value('foo');
    expect((await client.get('leased').exec()).kvs[0].lease).toBe(await lease.grant());
    await lease.revoke();
    expect(await client.get('leased').buffer()).toBeNull();
  });

  it('attaches leases through transactions', async () => {
    lease = client.lease(100);
    await lease.put('leased').value('foo');

    const result = await client
      .if('foo1', 'Value', '==', 'bar1')
      .then(lease.put('leased').value('foo'))
      .commit();
    expect(result.succeeded, 'expected to have completed transaction').toBe(true);
    expect((await client.get('leased').exec()).kvs[0].lease).toBe(await lease.grant());
    await lease.revoke();
    expect(await client.get('leased').buffer()).toBeNull();
  });

  it('runs immediate keepalives', async () => {
    lease = client.lease(100);
    expect(await lease.keepaliveOnce()).toMatchObject({
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
    proxy.suspend();
    await onceEvent(lease, 'keepaliveFailed');
    proxy.unsuspend();
    await onceEvent(lease, 'keepaliveSucceeded');
    await lease.revoke();

    proxiedClient.close();
    await proxy.deactivate();
  });

  it('marks leases as failed if the server is not contacted for a while', async () => {
    await proxy.activate();
    const proxiedClient = new Etcd3(getOptions());

    lease = proxiedClient.lease(1);
    await lease.grant();
    proxy.suspend();
    (lease as any).lastKeepAlive = Date.now() - 2000; // speed things up a little
    const err = await onceEvent(lease, 'lost');
    expect(err.message).toMatch(/our lease has expired/);
    proxiedClient.close();
    await proxy.deactivate();
  });

  it('emits a lost event if the lease is invalidated', async () => {
    lease = client.lease(100);
    let err: Error;
    lease.on('lost', e => {
      expect(lease.revoked()).toBe(true);
      err = e;
    });

    expect(lease.revoked()).toBe(false);
    await client.leaseClient.leaseRevoke({ ID: await lease.grant() });

    await lease
      .keepaliveOnce()
      .then(() => {
        throw new Error('expected to reject');
      })
      .catch(err2 => {
        expect(err2).toBe(err);
        expect(err2).toBeInstanceOf(EtcdLeaseInvalidError);
        expect(lease.revoked()).toBe(true);
      });
  });

  it('emits a loss if the touched key is lost', async () => {
    lease = client.lease(100, { autoKeepAlive: false });
    (lease as any).leaseID = Promise.resolve('123456789');
    const lost = onceEvent(lease, 'lost');

    try {
      await lease.put('foo').value('bar');
    } catch (e) {
      expect(e).toBeInstanceOf(EtcdLeaseInvalidError);
      expect(e).toBe(await lost);
      expect(lease.revoked()).toBe(true);
    }
  });

  it('allows disabling auto keep alives', async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
    });

    lease = client.lease(60, { autoKeepAlive: false });

    const kaFired = watchEmission('keepaliveFired');
    vi.advanceTimersByTime(20000);
    expect(kaFired.fired).toBe(false);
  });

  describe('crons', () => {
    beforeEach(async () => {
      vi.useFakeTimers({
        shouldAdvanceTime: true,
      });
      lease = client.lease(60);
      await onceEvent(lease, 'keepaliveEstablished');
    });

    it('touches the lease ttl at the correct interval', async () => {
      const kaFired = watchEmission('keepaliveFired');
      vi.advanceTimersByTime(19999);
      expect(kaFired.fired).toBe(false);
      vi.advanceTimersByTime(1);
      expect(kaFired.fired).toBe(true);

      const res = await onceEvent(lease, 'keepaliveSucceeded');
      expect(res.TTL).toBe('60');
    });

    it('stops touching the lease if released passively', async () => {
      const kaFired = watchEmission('keepaliveFired');
      lease.release();
      vi.advanceTimersByTime(20000);
      expect(kaFired.fired).toBe(false);
    });

    it('marks leases as failed if etcd does not respond to keepalives in time (#110)', async () => {
      await lease.revoke();

      await proxy.activate();
      const proxiedClient = new Etcd3(getOptions());
      lease = proxiedClient.lease(1);
      await lease.grant();
      proxy.pause(TrafficDirection.FromEtcd);

      const failedEvent = watchEmission('keepaliveFailed');
      vi.advanceTimersByTime(50000);
      await unmockedDelay(2); // drain task queues

      expect(failedEvent.fired).toBe(false);
      vi.advanceTimersByTime(10000);
      await unmockedDelay(2); // drain task queues
      expect(failedEvent.fired).toBe(true);

      proxy.resume(TrafficDirection.FromEtcd);
      await lease.revoke();
      proxiedClient.close();
      proxy.deactivate();
    });

    it('tears down if the lease gets revoked', async () => {
      await client.leaseClient.leaseRevoke({ ID: await lease.grant() });
      vi.advanceTimersByTime(20000);
      expect(await onceEvent(lease, 'lost')).toBeInstanceOf(EtcdLeaseInvalidError);
      expect(lease.revoked()).toBe(true);
    });
  });
});
