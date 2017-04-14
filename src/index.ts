import { ConnectionPool } from './connection-pool';
import { DeleteBuilder, MultiRangeBuilder, PutBuilder, SingleRangeBuilder } from './kv-builder';
import { Lease } from './lease';
import { IOptions } from './options';
import * as RPC from './rpc';

export * from './errors';
export * from './kv-builder';
export * from './lease';
export * from './rpc';

/**
 * Etcd3 is a high-level interface for interacting and calling etcd endpoints.
 * It also provides several lower-level clients for directly calling methods.
 *
 * ```
 * const { Etcd3 } = require('etcd3');
 * const client = new Etcd3();
 *
 * await client.put('foo').value('bar');
 * console.log('foo is:', await client.get('foo').string());
 *
 * const keys = await client.getAll().prefix('f').strings();
 * console.log('all keys starting with "f": keys);
 *
 * await client.delete().all();
 * ```
 */
export class Etcd3 {

  private pool = new ConnectionPool(this.options);

  public readonly kv = new RPC.KVClient(this.pool);
  public readonly leaseClient = new RPC.LeaseClient(this.pool);
  public readonly auth = new RPC.AuthClient(this.pool);
  public readonly maintenance = new RPC.MaintenanceClient(this.pool);
  public readonly watch = new RPC.WatchClient(this.pool);
  public readonly cluster = new RPC.ClusterClient(this.pool);

  constructor(private options: IOptions = { hosts: '127.0.0.1:2379' }) {}

  /**
   * `.get()` starts a query to look up a single key from etcd.
   */
  public get(key: string): SingleRangeBuilder {
    return new SingleRangeBuilder(this.kv, key);
  }

  /**
   * `.getAll()` starts a query to look up multiple keys from etcd.
   */
  public getAll(): MultiRangeBuilder {
    return new MultiRangeBuilder(this.kv);
  }

  /**
   * `.put()` starts making a put request against etcd.
   */
  public put(key: string | Buffer): PutBuilder {
    return new PutBuilder(this.kv, key);
  }

  /**
   * `.delete()` starts making a delete request against etcd.
   */
  public delete(): DeleteBuilder {
    return new DeleteBuilder(this.kv);
  }

  /**
   * `lease()` grants and returns a new Lease instance. The Lease is
   * automatically kept alive for you until it is revoked.
   *
   * Leases are great for things like service discovery:
   *
   * ```
   * const os = require('os');
   * const { Etcd3 } = require('etcd3');
   * const client = new Etcd3();
   *
   * const hostPrefix = 'available-hosts/';
   * function grantLease() {
   *   const lease = client.lease();
   *
   *   lease.on('lost', err => {
   *     console.log('We lost our lease as a result of this error:', err);
   *     console.log('Trying to re-grant it...');
   *     grantLease();
   *   })
   *
   *   await lease.put(hostPrefix + os.hostname()).value('');
   * }
   *
   * function getAvailableHosts() {
   *   const keys = await client.get().keys().strings();
   *   return keys.map(key => key.slice(hostPrefix.length));
   * }
   * ```
   */
  public lease(ttl: number): Lease {
    return new Lease(this.pool, ttl);
  }

  /**
   * `.mock()` allows you to insert an interface that will be called into
   * instead of calling out to the "real" service. `unmock` should be called
   * after mocking is finished.
   *
   * For example:
   *
   * ```
   * const sinon = require('sinon');
   * const { expect } = require('chai');
   *
   * const { Etcd3 } = require('etcd3');
   * const client = new Etcd3();
   *
   * const mock = client.mock({ exec: sinon.stub() });
   * mock.exec.resolves({ kvs: [{ key: 'foo', value: 'bar' }]});
   * const output = client.get('foo').string();
   * expect(output).to.equal('bar');
   * client.unmock();
   * ```
   */
  public mock<T extends Partial<RPC.ICallable>>(callable: T): T {
    this.pool.mock(<any> callable);
    return callable;
  }

  /**
   * Removes any previously-inserted mock.
   */
  public unmock(): void {
    this.pool.unmock();
  }

  /**
   * Frees resources associated with the client.
   */
  public close() {
    this.pool.close();
  }
}
