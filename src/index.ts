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
   * `.get` starts a query to look up a single key from etcd.
   */
  public get(key: string): SingleRangeBuilder {
    return new SingleRangeBuilder(this.kv, key);
  }

  /**
   * `.getAll` starts a query to look up multiple keys from etcd.
   */
  public getAll(): MultiRangeBuilder {
    return new MultiRangeBuilder(this.kv);
  }

  /**
   * `.put` starts making a put request against etcd.
   */
  public put(key: string | Buffer): PutBuilder {
    return new PutBuilder(this.kv, key);
  }

  /**
   * `.delete` starts making a delete request against etcd.
   */
  public delete(): DeleteBuilder {
    return new DeleteBuilder(this.kv);
  }

  /**
   * lease grants and returns a new Lease instance.
   */
  public lease(ttl: number): Lease {
    return new Lease(this.pool, ttl);
  }

  /**
   * Frees resources associated with the client.
   */
  public close() {
    this.pool.close();
  }
}
