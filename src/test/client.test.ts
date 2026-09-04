/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Etcd3 } from '..';
import { createTestClientAndKeys, tearDownTestClient } from './util';

describe('client', () => {
  let client: Etcd3;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => await tearDownTestClient(client));

  it('allows mocking', async () => {
    const exec = vi.fn().mockResolvedValue({ kvs: [] });
    client.mock({
      exec: exec as any,
    });

    expect(await client.get('foo1').string()).toBeNull();
    expect(
      exec.mock.calls.some(([service, method]) => service === 'KV' && method === 'range'),
    ).toBe(true);
    client.unmock();
    expect(await client.get('foo1').string()).toBe('bar1');
  });
});
