/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';
import { NoopPolicy, handleAll, retry } from 'cockatiel';
import { stub } from 'sinon';
import { IOptions, KVClient } from '..';
import { ConnectionPool } from '../connection-pool';
import { GRPCDeadlineExceededError, GRPCUnavailableError } from '../errors';
import { getHost, getOptions } from './util';

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
    expect(res.kvs).to.containSubset([{ key, value }]);

    await kv.deleteRange({ key });
  });

  it('applies call options', async () => {
    const optsStub = stub()
      .onFirstCall()
      .returns({ deadline: new Date(0) })
      .onSecondCall()
      .returns({ deadline: new Date(Date.now() + 30_000) });

    const pool = new ConnectionPool({ ...getOptions(), defaultCallOptions: optsStub });

    const kv = new KVClient(pool);
    await expect(kv.range({ key })).to.be.rejectedWith(GRPCDeadlineExceededError);
    expect(await kv.range({ key })).be.ok;
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
    ).to.throw(/mix of secure and insecure hosts/);
  });

  it('rejects hitting invalid hosts', () => {
    pool = new ConnectionPool(getOptionsWithBadHost());
    const kv = new KVClient(pool);
    return kv
      .range({ key })
      .then(() => {
        throw new Error('expected to reject');
      })
      .catch(err => expect(err).to.be.an.instanceof(GRPCUnavailableError));
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
    expect((await kv.range({ key })).kvs).to.deep.equal([]);
  });
});
