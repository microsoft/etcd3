/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { Role, User } from './auth';
import { ConnectionPool } from './connection-pool';
import { Namespace } from './namespace';
import type { IOptions } from './options';
import * as RPC from './rpc';

export * from './auth';
export * from './builder';
export * from './errors';
export * from './lease';
export * from './lock';
export * from './namespace';
export * from './options';
export * from './range';
export * from './rpc';
export * from './stm';
export * from './election';
export { WatchBuilder, Watcher } from './watch';

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
export class Etcd3 extends Namespace {
  /**
   * @internal
   */
  public readonly auth = new RPC.AuthClient(this.pool);

  /**
   * @internal
   */
  public readonly maintenance = new RPC.MaintenanceClient(this.pool);

  /**
   * @internal
   */
  public readonly cluster = new RPC.ClusterClient(this.pool);

  /**
   * Creates a new etcd3 client. See the docs on the {@link IOptions} for
   * more information.
   */
  constructor(options: IOptions = { hosts: '127.0.0.1:2379' }) {
    super(Buffer.from([]), new ConnectionPool(options), options);
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
   * const { Etcd3 } = require('etcd3');
   * const client = new Etcd3();
   *
   * client.mock({
   *   exec: async (service, method) => {
   *     if (service === 'KV' && method === 'range') {
   *       return {
   *         header: { cluster_id: '0', member_id: '0', revision: '0', raft_term: '0' },
   *         kvs: [{ key: Buffer.from('foo'), value: Buffer.from('bar') }],
   *         more: false,
   *         count: '1',
   *       };
   *     }
   *
   *     throw new Error(`Unexpected call: ${service}.${method}`);
   *   },
   * });
   *
   * const output = await client.get('foo').string();
   * console.log(output); // 'bar'
   * client.unmock();
   * ```
   */
  public mock<T extends Partial<RPC.ICallable<any>>>(callable: T): T {
    this.pool.mock(callable as any);
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
