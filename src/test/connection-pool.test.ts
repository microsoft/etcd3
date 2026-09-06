/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoopPolicy, handleAll, handleWhen, retry } from 'cockatiel';
import * as grpc from '@grpc/grpc-js';
import { KVClient } from '../index.js';
import type { IOptions } from '../index.js';
import { ConnectionPool } from '../connection-pool.js';
import { GRPCDeadlineExceededError, GRPCUnavailableError } from '../errors.js';
import { getHost, getOptions } from './util.js';

function getOptionsWithBadHost(options: Partial<IOptions> = {}): IOptions {
  return getOptions({
    hosts: [getHost(), '127.0.0.1:1'],
    ...options,
  });
}

describe('connection pool', () => {
  const key = Buffer.from('foo');
  const value = Buffer.from('bar');
  let pool: ConnectionPool | null;

  afterEach(() => {
    if (pool) {
      pool.close();
      pool = null;
    }
  });

  it('calls simple methods', async () => {
    pool = new ConnectionPool(getOptions());
    const kv = new KVClient(pool);
    await kv.put({ key, value });
    const res = await kv.range({ key });
    expect(res.kvs).toMatchObject([{ key, value }]);

    await kv.deleteRange({ key });
  });

  it('applies call options', async () => {
    const optsStub = vi
      .fn()
      .mockReturnValueOnce({ deadline: new Date(0) })
      .mockReturnValueOnce({ deadline: new Date(Date.now() + 30_000) });

    const pool = new ConnectionPool({ ...getOptions(), defaultCallOptions: optsStub });

    const kv = new KVClient(pool);
    await expect(kv.range({ key })).rejects.toThrow(GRPCDeadlineExceededError);
    expect(await kv.range({ key })).toBeTruthy();
  });

  it('forwards call-specific options to mocked calls', async () => {
    pool = new ConnectionPool(getOptions());
    const exec = vi.fn().mockResolvedValue({ kvs: [] });
    const options = { deadline: new Date(0) };
    pool.mock({ exec } as any);

    await pool.exec('KV', 'range', { key }, options);

    expect(exec).toHaveBeenCalledWith('KV', 'range', { key }, options);
  });

  it('caches authentication metadata per host and falls back after authentication failures', async () => {
    const clients: Array<{
      address: string;
      callbackCompleted: boolean;
      closed: boolean;
      close: () => void;
    }> = [];

    class AuthClient {
      public callbackCompleted = false;
      public closed = false;
      public close = vi.fn(() => {
        expect(this.callbackCompleted).toBe(true);
        this.closed = true;
      });

      constructor(public readonly address: string) {
        clients.push(this);
      }

      public authenticate(
        _request: unknown,
        _metadata: unknown,
        _options: unknown,
        callback: (error: Error | null, response?: { token: string }) => void,
      ) {
        if (this.address === 'failure') {
          callback(new Error('authentication failed'));
        } else {
          callback(null, { token: `token-for-${this.address}` });
        }
        this.callbackCompleted = true;
      }
    }

    class ServiceClient {
      constructor(address: string) {
        void address;
      }
    }

    vi.resetModules();
    vi.doMock('@grpc/grpc-js', async importOriginal => {
      const grpc = await importOriginal<typeof import('@grpc/grpc-js')>();
      return {
        ...grpc,
        loadPackageDefinition: () => ({ etcdserverpb: { Auth: AuthClient, KV: ServiceClient } }),
      };
    });
    vi.doMock('@grpc/proto-loader', () => ({ loadSync: vi.fn() }));

    try {
      const { ConnectionPool: TestConnectionPool } = await import('../connection-pool.js');
      const options = (hosts: string[]): IOptions => ({
        hosts,
        auth: { username: 'user', password: 'password' },
        faultHandling: {
          global: new NoopPolicy(),
          host: () => new NoopPolicy(),
        },
      });

      const successfulPool = new TestConnectionPool(options(['success']));
      const successfulAuth = (successfulPool as any).authenticator;
      expect((await successfulAuth.getMetadata('success')).get('token')).toEqual([
        'token-for-success',
      ]);
      await successfulAuth.getMetadata('success');
      expect((await successfulAuth.getMetadata('other')).get('token')).toEqual(['token-for-other']);
      successfulAuth.invalidateMetadata('success');
      await successfulAuth.getMetadata('success');
      successfulPool.reportStreamError(
        (successfulPool as any).hosts[0],
        new Error('etcdserver: invalid auth token'),
        false,
      );
      expect((await successfulAuth.getMetadata('success')).get('token')).toEqual([
        'token-for-success',
      ]);

      const failedPool = new TestConnectionPool(options(['failure']));
      await expect((failedPool as any).authenticator.getMetadata('failure')).rejects.toThrow(
        'authentication failed',
      );

      const fallbackPool = new TestConnectionPool(options(['failure', 'fallback']));
      const hosts = (fallbackPool as any).hosts;
      function* fallbackOrder() {
        yield* hosts;
      }
      const fallbackMetadata = await fallbackPool.withConnection(
        'KV',
        ({ metadata }) => metadata,
        fallbackOrder(),
      );

      expect(fallbackMetadata.get('token')).toEqual(['token-for-fallback']);
      expect(clients).toHaveLength(7);
      expect(clients.every(client => client.closed)).toBe(true);
      expect(clients.map(client => client.address)).toEqual([
        'success',
        'other',
        'success',
        'success',
        'failure',
        'failure',
        'fallback',
      ]);
    } finally {
      vi.doUnmock('@grpc/grpc-js');
      vi.doUnmock('@grpc/proto-loader');
      vi.resetModules();
    }
  });

  it('retries an invalid token once without recursively reissuing the request', async () => {
    let authCalls = 0;
    let rangeCalls = 0;

    class AuthClient {
      constructor(address: string) {
        void address;
      }

      public close() {}

      public authenticate(
        _request: unknown,
        _metadata: unknown,
        _options: unknown,
        callback: (error: Error | null, response?: { token: string }) => void,
      ) {
        authCalls++;
        callback(null, { token: `token-${authCalls}` });
      }
    }

    class KVClient {
      constructor(address: string) {
        void address;
      }

      public range(
        _request: unknown,
        _metadata: unknown,
        _options: unknown,
        callback: (error: Error | null) => void,
      ) {
        rangeCalls++;
        callback(new Error('etcdserver: invalid auth token'));
      }
    }

    vi.resetModules();
    vi.doMock('@grpc/grpc-js', async importOriginal => {
      const grpc = await importOriginal<typeof import('@grpc/grpc-js')>();
      return {
        ...grpc,
        loadPackageDefinition: () => ({ etcdserverpb: { Auth: AuthClient, KV: KVClient } }),
      };
    });
    vi.doMock('@grpc/proto-loader', () => ({ loadSync: vi.fn() }));

    try {
      const { ConnectionPool: TestConnectionPool } = await import('../connection-pool.js');
      const testPool = new TestConnectionPool({
        hosts: ['invalid'],
        auth: { username: 'user', password: 'password' },
        faultHandling: {
          global: new NoopPolicy(),
          host: () => new NoopPolicy(),
        },
      });

      await expect(testPool.exec('KV', 'range', {})).rejects.toThrow('invalid auth token');
      expect(authCalls).toBe(2);
      expect(rangeCalls).toBe(2);
    } finally {
      vi.doUnmock('@grpc/grpc-js');
      vi.doUnmock('@grpc/proto-loader');
      vi.resetModules();
    }
  });

  it('refreshes the selected host token once before global retries fail over', async () => {
    const authenticationCalls = new Map<string, number>();
    const requests: Array<{ address: string; token: string }> = [];
    let freshSecondRequests = 0;

    class AuthClient {
      constructor(public readonly address: string) {}

      public close() {}

      public authenticate(
        _request: unknown,
        _metadata: unknown,
        _options: unknown,
        callback: (error: Error | null, response?: { token: string }) => void,
      ) {
        const calls = (authenticationCalls.get(this.address) ?? 0) + 1;
        authenticationCalls.set(this.address, calls);
        callback(null, {
          token: calls === 1 ? `stale-${this.address}` : `fresh-${this.address}`,
        });
      }
    }

    class KVClient {
      constructor(public readonly address: string) {}

      public close() {}

      public getChannel() {
        return { getConnectivityState: () => grpc.connectivityState.READY };
      }

      public range(
        _request: unknown,
        metadata: { get(key: string): unknown[] },
        _options: unknown,
        callback: (error: Error | null, response?: { kvs: unknown[] }) => void,
      ) {
        const token = String(metadata.get('token')[0]);
        requests.push({ address: this.address, token });
        if (token === 'stale-second') {
          callback(new Error('etcdserver: invalid auth token'));
        } else if (token === 'fresh-second' && ++freshSecondRequests === 2) {
          callback(null, { kvs: [] });
        } else {
          callback(
            Object.assign(new Error('temporarily unavailable'), { code: grpc.status.UNAVAILABLE }),
          );
        }
      }
    }

    vi.resetModules();
    vi.doMock('@grpc/grpc-js', async importOriginal => {
      const grpc = await importOriginal<typeof import('@grpc/grpc-js')>();
      return {
        ...grpc,
        loadPackageDefinition: () => ({ etcdserverpb: { Auth: AuthClient, KV: KVClient } }),
      };
    });
    vi.doMock('@grpc/proto-loader', () => ({ loadSync: vi.fn() }));

    try {
      const { ConnectionPool: TestConnectionPool } = await import('../connection-pool.js');
      TestConnectionPool.deterministicOrder = true;
      const testPool = new TestConnectionPool({
        hosts: ['first', 'second'],
        auth: { username: 'user', password: 'password' },
        faultHandling: {
          global: retry(
            handleWhen(error => error instanceof Error && error.name === 'GRPCUnavailableError'),
            { maxAttempts: 3 },
          ),
          host: () => new NoopPolicy(),
        },
      });
      const authenticator = (testPool as any).authenticator;
      await authenticator.getMetadata('first');
      await authenticator.getMetadata('second');

      await expect(testPool.exec('KV', 'range', {})).resolves.toEqual({ kvs: [] });

      expect(requests).toEqual([
        { address: 'second', token: 'stale-second' },
        { address: 'second', token: 'fresh-second' },
        { address: 'first', token: 'stale-first' },
        { address: 'second', token: 'fresh-second' },
      ]);
      expect(authenticationCalls).toEqual(
        new Map([
          ['first', 1],
          ['second', 2],
        ]),
      );
    } finally {
      vi.doUnmock('@grpc/grpc-js');
      vi.doUnmock('@grpc/proto-loader');
      vi.resetModules();
    }
  });

  it('does not penalize a host for local stream cancellation', async () => {
    const execute = vi.fn((fn: () => unknown) => Promise.resolve().then(fn));
    pool = new ConnectionPool(
      getOptions({
        faultHandling: {
          global: new NoopPolicy(),
          host: () => ({ execute }) as any,
        },
      }),
    );
    const host = (pool as any).hosts[0];
    const resetAllServices = vi.spyOn(host, 'resetAllServices');
    const cancelled = Object.assign(new Error('cancelled'), { code: grpc.status.CANCELLED });

    pool.reportStreamError(host, cancelled, true);

    expect(resetAllServices).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    pool.reportStreamError(
      host,
      Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      }),
      true,
    );

    expect(resetAllServices).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    pool.reportStreamError(
      host,
      Object.assign(new Error('unavailable'), { code: grpc.status.UNAVAILABLE }),
      true,
    );
    await Promise.resolve();

    expect(resetAllServices).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects instantiating with a mix of secure and unsecure hosts', () => {
    expect(
      () =>
        new ConnectionPool(
          getOptions({
            hosts: ['https://server1', 'http://server2'], // tslint:disable-line
            credentials: undefined,
          }),
        ),
    ).toThrow(/mix of secure and insecure hosts/);
  });

  it('rejects hitting invalid hosts', () => {
    pool = new ConnectionPool(getOptionsWithBadHost());
    const kv = new KVClient(pool);
    return kv
      .range({ key })
      .then(() => {
        throw new Error('expected to reject');
      })
      .catch(err => expect(err).toBeInstanceOf(GRPCUnavailableError));
  });

  it('should retry through policy', async () => {
    pool = new ConnectionPool(
      getOptionsWithBadHost({
        faultHandling: {
          global: retry(handleAll, { maxAttempts: 3 }),
          host: () => new NoopPolicy(),
        },
      }),
    );
    const kv = new KVClient(pool);
    expect((await kv.range({ key })).kvs).toEqual([]);
  });
});
