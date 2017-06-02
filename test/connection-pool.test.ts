import { expect } from 'chai';

import { ConnectionPool } from '../src/connection-pool';
import { KVClient } from '../src/rpc';
import { GRPCConnectFailedError, IOptions } from '../src';
import { getOptions, getHost } from './util';

function getOptionsWithBadHost(options: Partial<IOptions> = {}): IOptions {
  return getOptions({
    hosts: ['127.0.0.1:1', getHost()],
    ...options,
  });
}

describe('connection pool', () => {
  const key = new Buffer('foo');
  const value = new Buffer('bar');
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

  it('rejects hitting invalid hosts', () => {
    pool = new ConnectionPool(getOptionsWithBadHost());
    const kv = new KVClient(pool);
    return kv.range({ key })
      .then(() => { throw new Error('expected to reject'); })
      .catch(err => expect(err).to.be.an.instanceof(GRPCConnectFailedError));
  });

  it('retries when requested', async () => {
    pool = new ConnectionPool(getOptionsWithBadHost({ retry: true }));
    const kv = new KVClient(pool);
    expect((await kv.range({ key })).kvs).to.deep.equal([]);
  });
});
