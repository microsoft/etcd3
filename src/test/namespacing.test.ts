/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Etcd3 } from '../index.js';
import type { Namespace } from '../index.js';
import { createTestClientAndKeys, tearDownTestClient } from './util.js';

describe('namespacing', () => {
  let client: Etcd3;
  let ns: Namespace;

  beforeEach(async () => {
    client = await createTestClientAndKeys();
    ns = client.namespace('user1/');
  });

  afterEach(async () => await tearDownTestClient(client));

  const assertEqualInNamespace = async (key: string, value: string) => {
    expect(await ns.get(key)).toBe(value);
    expect(await client.get(`user1/${key}`)).toBe(value);
  };

  it('puts and gets values in the namespace', async () => {
    await ns.put('foo').value('');
    await assertEqualInNamespace('foo', '');
    expect(await ns.getAll().strings()).toEqual({ foo: '' });
  });

  it('deletes values in the namespace', async () => {
    await ns.put('foo1').value('');
    await ns.put('foo2').value('');

    await ns.delete().key('foo1');
    expect(await ns.getAll().strings()).toEqual({ foo2: '' });
    await ns.delete().all();

    expect(await ns.getAll().strings()).toEqual({});
    expect(await client.getAll().keys()).not.toHaveLength(0);
  });

  it('includes and deletes the logical empty namespace key', async () => {
    const zeroByteKey = Buffer.from([0]);

    await ns.put('').value('empty');
    await ns.put('ordinary').value('ordinary');
    await ns.put(zeroByteKey).value('zero-byte');
    await client.put('outside').value('outside');

    const expected = { '': 'empty', ordinary: 'ordinary', '\0': 'zero-byte' };
    expect(await ns.getAll().strings()).toEqual(expected);
    expect(await ns.getAll().all().strings()).toEqual(expected);
    expect(await ns.get(zeroByteKey)).toBe('zero-byte');

    await ns.delete().all();

    expect(await ns.getAll().strings()).toEqual({});
    expect(await client.get('user1/')).toBeNull();
    expect(await client.get('user1/ordinary')).toBeNull();
    expect(await client.get(Buffer.concat([Buffer.from('user1/'), zeroByteKey]))).toBeNull();
    expect(await client.get('outside')).toBe('outside');
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
    expect(await ns.get('mylock')).not.toBeNull();
    expect(await client.get('user1/mylock')).not.toBeNull();
    await lock.release();
  });

  it('runs a simple if', async () => {
    await ns.put('foo1').value('potatoes');
    await ns.if('foo1', 'Value', '==', 'potatoes').then(ns.put('foo1').value('tomatoes')).commit();

    await assertEqualInNamespace('foo1', 'tomatoes');
  });
});
