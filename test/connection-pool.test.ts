import { expect } from 'chai';

import { GRPCConnectFailedError, IOptions, KVClient } from '../src';
import { ConnectionPool } from '../src/connection-pool';
import { getHost, getOptions } from './util';

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

  it('rejects passing a password with insecure hosts', () => {
    // Some people opened issues about this, so rather than letting grpc throw
    // its cryptic error, let's make sure we throw a nicer one.
    expect(
      () =>
        new ConnectionPool(
          getOptions({
            hosts: 'http://server1', // tslint:disable-line
            credentials: undefined,
            auth: { username: 'connor', password: 'password' },
          }),
        ),
    ).to.throw(/grpc does not allow/);
  });

  it('rejects hitting invalid hosts', () => {
    pool = new ConnectionPool(getOptionsWithBadHost());
    const kv = new KVClient(pool);
    return kv
      .range({ key })
      .then(() => {
        throw new Error('expected to reject');
      })
      .catch(err => expect(err).to.be.an.instanceof(GRPCConnectFailedError));
  });

  it('retries when requested', async () => {
    pool = new ConnectionPool(getOptionsWithBadHost({ retry: true }));
    const kv = new KVClient(pool);
    expect((await kv.range({ key })).kvs).to.deep.equal([]);
  });
});
