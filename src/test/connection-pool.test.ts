/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';

import { IOptions, KVClient } from '..';
import { ConnectionPool } from '../connection-pool';
import { getHost, getOptions } from './util';
import { Policy } from 'cockatiel';
import { GRPCUnavailableError } from '../errors';

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
          global: Policy.handleAll().retry().attempts(3),
          host: () => Policy.noop,
        },
      }),
    );
    const kv = new KVClient(pool);
    expect((await kv.range({ key })).kvs).to.deep.equal([]);
  });
});
