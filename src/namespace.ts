/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { ExponentialBackoff } from 'cockatiel';
import * as Builder from './builder.js';
import { ConnectionPool } from './connection-pool.js';
import { Election } from './election.js';
import { Lease } from './lease.js';
import type { ILeaseOptions } from './lease.js';
import { Lock } from './lock.js';
import type { IOptions } from './options.js';
import { Range } from './range.js';
import type { Rangable } from './range.js';
import * as RPC from './rpc.js';
import { Isolation, SoftwareTransaction } from './stm.js';
import type { ISTMOptions } from './stm.js';
import { NSApplicator, toBuffer } from './util.js';
import { WatchBuilder, WatchManager } from './watch.js';

/**
 * Namespace is the class on which CRUD operations can be invoked. The default
 * namespace is the empty string, "". You can create nested namespaces by
 * calling the `namespace(prefix)` method.
 *
 * For example, if the current namespace is the default "" and you call
 * namespace('user1/'), all operations on that new namespace will be
 * automatically prefixed with `user1/`:
 *
 * ```
 * const client = new Etcd3();
 * const ns = client.namespace('user1/');
 *
 * await ns.put('foo').value('bar'); // sets the key `user1/foo` to `bar`
 * await ns.delete().all(); // deletes all keys with the prefix `user1/`
 * ```
 *
 * Namespacing is particularly useful to avoid clashing between multiple
 * applications and when using Etcd's access control.
 */
export class Namespace {
  /**
   * @internal
   */
  public readonly kv: RPC.KVClient;

  /**
   * @internal
   */
  public readonly leaseClient: RPC.LeaseClient;

  /**
   * @internal
   */
  public readonly watchClient: RPC.WatchClient;
  private readonly nsApplicator: NSApplicator;
  private readonly watchManager: WatchManager;

  protected constructor(
    /** @internal */
    public readonly prefix: Buffer,
    /** @internal */
    protected readonly pool: ConnectionPool,
    /** @internal */
    protected readonly options: IOptions,
  ) {
    this.kv = new RPC.KVClient(pool);
    this.leaseClient = new RPC.LeaseClient(pool);
    this.watchClient = new RPC.WatchClient(pool);
    this.nsApplicator = new NSApplicator(prefix);
    this.watchManager = new WatchManager(
      this.watchClient,
      options.faultHandling?.watchBackoff ?? new ExponentialBackoff(),
    );
  }

  /**
   * `.get()` starts a query to look up a single key from etcd.
   */
  public get(key: string | Buffer): Builder.SingleRangeBuilder {
    return new Builder.SingleRangeBuilder(this.kv, this.nsApplicator, key);
  }

  /**
   * `.getAll()` starts a query to look up multiple keys from etcd.
   */
  public getAll(): Builder.MultiRangeBuilder {
    return new Builder.MultiRangeBuilder(this.kv, this.nsApplicator);
  }

  /**
   * `.put()` starts making a put request against etcd.
   */
  public put(key: string | Buffer): Builder.PutBuilder {
    return new Builder.PutBuilder(this.kv, this.nsApplicator, key);
  }

  /**
   * `.delete()` starts making a delete request against etcd.
   */
  public delete(): Builder.DeleteBuilder {
    return new Builder.DeleteBuilder(this.kv, this.nsApplicator);
  }

  /**
   * `lease()` grants and returns a new Lease instance. The Lease is
   * automatically kept alive for you until it is revoked. See the
   * documentation on the Lease class for some examples.
   */
  public lease(ttl: number, options?: ILeaseOptions): Lease {
    return new Lease(this.pool, this.nsApplicator, ttl, options);
  }

  /**
   * `lock()` is a helper to provide distributed locking capability. See
   * the documentation on the Lock class for more information and examples.
   */
  public lock(key: string | Buffer): Lock {
    return new Lock(this.pool, this.nsApplicator, key);
  }

  /**
   * `stm()` creates a new software transaction, see more details about how
   * this works and why you might find this useful
   * on the SoftwareTransaction class.
   */
  public stm(options?: Partial<ISTMOptions>): SoftwareTransaction {
    return new SoftwareTransaction(
      {
        isolation: Isolation.SerializableSnapshot,
        prefetch: [],
        retries: 3,
        ...options,
      },
      this.nsApplicator,
      this.kv,
    );
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
    return new Builder.ComparatorBuilder(this.kv, this.nsApplicator).and(key, column, cmp, value);
  }

  /**
   * `.watch()` creates a new watch builder. See the documentation on the
   * WatchBuilder for usage examples.
   */
  public watch(): WatchBuilder {
    return new WatchBuilder(this.watchManager, this.nsApplicator);
  }

  /**
   * Creates a structure representing an etcd range. Used in permission grants
   * and queries. This is a convenience method for `Etcd3.Range.from(...)`.
   */
  public range(r: Rangable): Range {
    return Range.from(r);
  }

  /**
   * namespace adds a prefix and returns a new Namespace, which is used for
   * operating on keys in a prefixed domain. For example, if the current
   * namespace is the default "" and you call namespace('user1/'), all
   * operations on that new namespace will be automatically prefixed
   * with `user1/`. See the Namespace class for more details.
   */
  public namespace(prefix: string | Buffer): Namespace {
    return new Namespace(Buffer.concat([this.prefix, toBuffer(prefix)]), this.pool, this.options);
  }

  /**
   * Creates a new {@link Election} instead. See more information on the
   * Election class documentation.
   * @param name Name of the election in the etcd instance.
   * @param ttl Lease TTL used in the election. This is the maximum time that
   * a node which goes down can remain the leader before being
   * automatically evicted.
   */
  public election(name: string, ttl?: number) {
    return new Election(this, name, ttl);
  }
}
