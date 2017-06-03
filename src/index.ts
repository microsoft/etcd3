import { Role, User } from './auth';
import * as Builder from './builder';
import { ConnectionPool } from './connection-pool';
import { Lease } from './lease';
import { Lock } from './lock';
import { IOptions } from './options';
import { Rangable, Range } from './range';
import * as RPC from './rpc';

export * from './auth';
export * from './builder';
export * from './errors';
export * from './lease';
export * from './options';
export * from './range';
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
 * console.log('all keys starting with "f"': keys);
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
  public get(key: string): Builder.SingleRangeBuilder {
    return new Builder.SingleRangeBuilder(this.kv, key);
  }

  /**
   * `.getAll()` starts a query to look up multiple keys from etcd.
   */
  public getAll(): Builder.MultiRangeBuilder {
    return new Builder.MultiRangeBuilder(this.kv);
  }

  /**
   * `.put()` starts making a put request against etcd.
   */
  public put(key: string | Buffer): Builder.PutBuilder {
    return new Builder.PutBuilder(this.kv, key);
  }

  /**
   * `.delete()` starts making a delete request against etcd.
   */
  public delete(): Builder.DeleteBuilder {
    return new Builder.DeleteBuilder(this.kv);
  }

  /**
   * `lease()` grants and returns a new Lease instance. The Lease is
   * automatically kept alive for you until it is revoked. See the
   * documentation on the Lease class for some examples.
   */
  public lease(ttl: number): Lease {
    return new Lease(this.pool, ttl);
  }

  /**
   * `lock()` is a helper to provide distributed locking capability. See
   * the documentation on the Lock class for more information and examples.
   */
  public lock(key: string | Buffer): Lock {
    return new Lock(this.pool, key);
  }

  /**
   * `if()` starts a new etcd transaction, which allows you to execute complex
   * statements atomically. See documentation on the ComparatorBuilder for
   * more information.
   */
  public if(
    key: string | Buffer,
    column: keyof typeof Builder.compareTarget,
    cmp: keyof typeof Builder.comparator,
    value: string | Buffer | number,
  ): Builder.ComparatorBuilder {
    return new Builder.ComparatorBuilder(this.kv).and(key, column, cmp, value);
  }

  /**
   * Creates a structure representing an etcd range. Used in permission grants
   * and queries. This is a convenience method for `Etcd3.Range.from(...)`.
   */
  public range(r: Rangable): Range {
    return Range.from(r);
  }

  /**
   * Resolves to an array of roles available in etcd.
   */
  public getRoles(): Promise<Role[]> {
    return this.auth.roleList().then(result => {
      return result.roles.map(role => new Role(this.auth, role));
    });
  }

  /**
   * Returns an object to manipulate the role with the provided name.
   */
  public role(name: string): Role {
    return new Role(this.auth, name);
  }

  /**
   * Resolves to an array of users available in etcd.
   */
  public getUsers(): Promise<User[]> {
    return this.auth.userList().then(result => {
      return result.users.map(user => new User(this.auth, user));
    });
  }

  /**
   * Returns an object to manipulate the user with the provided name.
   */
  public user(name: string): User {
    return new User(this.auth, name);
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
