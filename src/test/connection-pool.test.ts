/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoopPolicy, handleAll, retry } from 'cockatiel';
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

  it('closes transient auth clients after every completed authentication attempt', async () => {
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

    vi.resetModules();
    vi.doMock('@grpc/grpc-js', async importOriginal => {
      const grpc = await importOriginal<typeof import('@grpc/grpc-js')>();
      return {
        ...grpc,
        loadPackageDefinition: () => ({ etcdserverpb: { Auth: AuthClient } }),
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
      await successfulAuth.getMetadata();
      successfulAuth.invalidateMetadata();
      await successfulAuth.getMetadata();

      const failedPool = new TestConnectionPool(options(['failure']));
      await expect((failedPool as any).authenticator.getMetadata()).rejects.toThrow(
        'authentication failed',
      );

      const fallbackPool = new TestConnectionPool(options(['failure', 'fallback']));
      const fallbackMetadata = await (fallbackPool as any).authenticator.getMetadata();

      expect(fallbackMetadata.get('token')).toEqual(['token-for-fallback']);
      expect(clients).toHaveLength(5);
      expect(clients.every(client => client.closed)).toBe(true);
      expect(clients.map(client => client.address)).toEqual([
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
