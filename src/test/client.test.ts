/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Etcd3 } from '../index.js';
import { createTestClientAndKeys, getOptions, tearDownTestClient } from './util.js';

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

describe('endpoint management', () => {
  let client: Etcd3;

  beforeEach(() => {
    client = new Etcd3(getOptions());
  });
  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  it('exposes a mutable endpoint list through defensive snapshots', () => {
    const initial = client.endpoints.list;
    initial.push('ignored');

    expect(client.endpoints.list).not.toContain('ignored');

    client.endpoints.list = ['first', 'second'];
    expect(client.endpoints.list).toEqual(['first', 'second']);

    client.endpoints.list = 'third';
    expect(client.endpoints.list).toEqual(['third']);
  });

  it('enables, reschedules, and disables automatic synchronization at runtime', async () => {
    vi.useFakeTimers();
    const exec = vi.fn().mockResolvedValue({
      members: [
        {
          ID: '1',
          name: 'member',
          peerURLs: [],
          clientURLs: ['https://member:2379'],
          isLearner: false,
        },
      ],
    });
    client.mock({ exec } as any);

    expect(client.endpoints.interval).toBeUndefined();
    client.endpoints.interval = 1_000;
    await vi.advanceTimersByTimeAsync(999);
    expect(exec).not.toHaveBeenCalled();

    client.endpoints.interval = 2_000;
    expect(client.endpoints.interval).toBe(2_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(exec).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exec).toHaveBeenCalledOnce();

    client.endpoints.interval = 0;
    expect(client.endpoints.interval).toBeUndefined();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(exec).toHaveBeenCalledOnce();
  });

  it('retains the current interval when a replacement is invalid', () => {
    vi.useFakeTimers();
    client.endpoints.interval = 1_000;

    expect(() => {
      client.endpoints.interval = 1.5;
    }).toThrow(/sync interval must be an integer from 0/);
    expect(client.endpoints.interval).toBe(1_000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('applies interval changes after an in-flight synchronization settles', async () => {
    vi.useFakeTimers();
    let resolveMembers:
      | ((value: {
          members: Array<{
            ID: string;
            name: string;
            peerURLs: string[];
            clientURLs: string[];
            isLearner: boolean;
          }>;
        }) => void)
      | undefined;
    const exec = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveMembers = resolve;
          }),
      )
      .mockResolvedValue({
        members: [
          {
            ID: '1',
            name: 'member',
            peerURLs: [],
            clientURLs: ['https://member:2379'],
            isLearner: false,
          },
        ],
      });
    client.mock({ exec } as any);
    client.endpoints.interval = 1_000;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(exec).toHaveBeenCalledOnce();

    client.endpoints.interval = 2_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exec).toHaveBeenCalledOnce();

    resolveMembers!({
      members: [
        {
          ID: '1',
          name: 'member',
          peerURLs: [],
          clientURLs: ['https://member:2379'],
          isLearner: false,
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(exec).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('synchronizes endpoints from started voting members', async () => {
    const exec = vi.fn().mockResolvedValue({
      members: [
        {
          ID: '1',
          name: '',
          peerURLs: [],
          clientURLs: ['https://unstarted:2379'],
          isLearner: false,
        },
        {
          ID: '2',
          name: 'learner',
          peerURLs: [],
          clientURLs: ['https://learner:2379'],
          isLearner: true,
        },
        {
          ID: '3',
          name: 'voter',
          peerURLs: [],
          clientURLs: ['https://first:2379', 'https://second:2379'],
          isLearner: false,
        },
      ],
    });
    const options = { deadline: new Date(Date.now() + 1_000) };
    client.mock({ exec } as any);

    await client.endpoints.sync(options);

    expect(exec).toHaveBeenCalledWith('Cluster', 'memberList', { linearizable: true }, options);
    expect(client.endpoints.list).toEqual(['https://first:2379', 'https://second:2379']);
  });

  it('coalesces concurrent endpoint synchronizations', async () => {
    let resolveMembers:
      | ((value: {
          members: Array<{
            ID: string;
            name: string;
            peerURLs: string[];
            clientURLs: string[];
            isLearner: boolean;
          }>;
        }) => void)
      | undefined;
    const exec = vi.fn(
      () =>
        new Promise(resolve => {
          resolveMembers = resolve;
        }),
    );
    client.mock({ exec } as any);

    const first = client.endpoints.sync();
    const second = client.endpoints.sync();

    expect(first).toBe(second);
    expect(exec).toHaveBeenCalledOnce();
    resolveMembers!({
      members: [
        {
          ID: '1',
          name: 'member',
          peerURLs: [],
          clientURLs: ['https://member:2379'],
          isLearner: false,
        },
      ],
    });
    await first;
    expect(client.endpoints.list).toEqual(['https://member:2379']);
  });

  it('preserves existing endpoints when synchronization finds no usable members', async () => {
    const initial = client.endpoints.list;
    client.mock({ exec: vi.fn().mockResolvedValue({ members: [] }) } as any);

    await expect(client.endpoints.sync()).rejects.toThrow(/no hosts specified/);
    expect(client.endpoints.list).toEqual(initial);
  });

  it('preserves explicitly assigned endpoints when an older sync completes', async () => {
    let resolveMembers:
      | ((value: {
          members: Array<{
            ID: string;
            name: string;
            peerURLs: string[];
            clientURLs: string[];
            isLearner: boolean;
          }>;
        }) => void)
      | undefined;
    const exec = vi.fn(
      () =>
        new Promise(resolve => {
          resolveMembers = resolve;
        }),
    );
    client.mock({ exec } as any);

    const sync = client.endpoints.sync();
    client.endpoints.list = 'https://manual:2379';
    resolveMembers!({
      members: [
        {
          ID: '1',
          name: 'discovered',
          peerURLs: [],
          clientURLs: ['https://discovered:2379'],
          isLearner: false,
        },
      ],
    });
    await sync;

    expect(client.endpoints.list).toEqual(['https://manual:2379']);
  });

  it('rejects manual sync failures without emitting warnings', async () => {
    const warning = vi.fn();
    const error = new Error('member list failed');
    client.endpoints.on('warn', warning);
    client.mock({ exec: vi.fn().mockRejectedValue(error) } as any);

    await expect(client.endpoints.sync()).rejects.toBe(error);
    expect(warning).not.toHaveBeenCalled();
  });

  it('warns on automatic sync failures and schedules another attempt', async () => {
    vi.useFakeTimers();
    const autoClient = new Etcd3(
      getOptions({
        hosts: {
          address: 'https://initial:2379',
          syncInterval: 1_000,
        },
      }),
    );
    const error = new Error('member list failed');
    const warning = vi.fn();
    const exec = vi.fn().mockRejectedValue(error);
    autoClient.endpoints.on('warn', warning);
    autoClient.mock({ exec } as any);

    try {
      await vi.advanceTimersByTimeAsync(1_000);

      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(error);
      expect(exec).toHaveBeenCalledWith(
        'Cluster',
        'memberList',
        { linearizable: true },
        { deadline: expect.any(Date) },
      );
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      autoClient.close();
      vi.useRealTimers();
    }
  });

  it('stops automatic endpoint synchronization when closed', async () => {
    vi.useFakeTimers();
    const autoClient = new Etcd3(
      getOptions({
        hosts: {
          address: 'https://initial:2379',
          syncInterval: 1_000,
        },
      }),
    );
    const exec = vi.fn();
    autoClient.mock({ exec } as any);

    autoClient.close();
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();

    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects interval changes after closing', () => {
    client.close();

    expect(() => {
      client.endpoints.interval = 1_000;
    }).toThrow(/client was already closed/);
  });
});
