import BigNumber from 'bignumber.js';
import * as grpc from 'grpc';

import * as Builder from './builder';
import { ClientRuntimeError, STMConflictError } from './errors';
import { Range } from './range';
import * as RPC from './rpc';
import { NSApplicator, toBuffer } from './util';

/**
 * Isolation level which can be passed into the ISTMOptions.
 */
export const enum Isolation {
  /**
   * SerializableSnapshot provides serializable isolation and
   * also checks for write conflicts.
   */
  SerializableSnapshot,

  /**
   * Serializable reads within the same transaction attempt return data
   * from the at the revision of the first read.
   */
  Serializable,

  /**
   * RepeatableReads reads within the same transaction attempt always
   * return the same data.
   */
  RepeatableReads,

  /**
   * ReadCommitted reads keys from any committed revision.
   */
  ReadCommitted,
}
/**
 * ISTMOptions are optionally passed to `etcd3.stm(options)`.
 */
export interface ISTMOptions {
  /**
   * Number of times we'll retry the transaction if we get a conflict.
   * Defaults to 3.
   */
  retries: number;

  /**
   * WithPrefetch is a hint to prefetch a list of keys before trying to apply.
   * If an STM transaction will unconditionally fetch a set of keys, prefetching
   * those keys will save the round-trip cost from requesting
   * each key one by one with `.get()`.
   */
  prefetch: string[];

  /**
   * Isolation level for the transaction. Defaults to SerializableSnapshot.
   */
  isolation: Isolation;

  /**
   * Options to pass into the STM transaction's commit.
   */
  callOptions?: grpc.CallOptions;
}

/**
 * Converts the key/value pair to a partial response that contains it. The
 * response *will not* contain header or revision information.
 */
function keyValueToResponse(key: string | Buffer, value?: Buffer): RPC.IRangeResponse {
  key = toBuffer(key);

  if (!value) {
    return { kvs: [], more: false, count: '0' } as any;
  }

  return {
    kvs: [
      {
        key: Buffer.from(key),
        value,
      },
    ],
    more: false,
    count: '1',
  } as any;
}

/**
 * ReadSet records a set of reads in a SoftwareTransaction.
 */
class ReadSet {
  private readonly reads: { [key: string]: Promise<RPC.IRangeResponse> } = Object.create(null);
  private readonly completedReads: Array<{ key: Buffer; res: RPC.IRangeResponse }> = [];
  private earliestMod = new BigNumber(Infinity);

  /**
   * Returns the earliest modified revision of any key in this change set.
   */
  public earliestModRevision(): BigNumber {
    return this.earliestMod;
  }

  /**
   * Add checks to the comparator to make sure that the mod revision of all
   * keys read during the transaction are the same.
   */
  public addCurrentChecks(cmp: Builder.ComparatorBuilder) {
    this.completedReads.forEach(({ key, res }) => {
      if (res.kvs.length) {
        cmp.and(key, 'Mod', '==', res.kvs[0].mod_revision);
      } else {
        cmp.and(key, 'Mod', '==', 0);
      }
    });
  }

  /**
   * runRequest sets read options and executes the outgoing request.
   */
  public runRequest(kv: RPC.KVClient, req: RPC.IRangeRequest): Promise<RPC.IRangeResponse> {
    const key = req.key!.toString();
    if (this.reads[key]) {
      return this.reads[key];
    }

    const promise = kv.range(req).then(res => {
      this.completedReads.push({ key: req.key!, res });

      if (res.kvs.length > 0) {
        this.earliestMod = BigNumber.min(new BigNumber(res.kvs[0].mod_revision), this.earliestMod);
      }

      return res;
    });

    this.reads[key] = promise;
    return promise;
  }
}

const enum WriteKind {
  Write,
  DeleteKey,
  DeleteRange,
}

type WriteOp =
  | { op: WriteKind.Write; req: RPC.IPutRequest }
  | { op: WriteKind.DeleteKey; key: Buffer; req: RPC.IDeleteRangeRequest }
  | { op: WriteKind.DeleteRange; range: Range; req: RPC.IDeleteRangeRequest };

/**
 * WriteSet records a set of writes in a SoftwareTransaction.
 */
class WriteSet {
  private readonly ops: WriteOp[] = [];

  /**
   * Add checks to make sure that none of the write tagets have changed since
   * the given revision.
   */
  public addNotChangedChecks(cmp: Builder.ComparatorBuilder, sinceBeforeMod: string) {
    if (sinceBeforeMod === 'Infinity') {
      return; // no reads were made
    }

    this.ops.forEach(op => {
      switch (op.op) {
        case WriteKind.Write:
          cmp.and(op.req.key!, 'Mod', '<', sinceBeforeMod);
          break;
        case WriteKind.DeleteKey:
          cmp.and(op.key, 'Mod', '<', sinceBeforeMod);
          break;
        case WriteKind.DeleteRange:
          // error, no way to check that every single key in that range is the same
          throw new Error(`You cannot delete ranges in the SerializableSnapshot isolation level`);
        default:
          throw new ClientRuntimeError(`Unexpected write op ${JSON.stringify(op)}`);
      }
    });
  }

  /**
   * Adds the changed keys as consequents of the builder.
   */
  public addChanges(cmp: Builder.ComparatorBuilder) {
    const clauses: RPC.IRequestOp[] = [];
    this.ops.forEach(op => {
      switch (op.op) {
        case WriteKind.Write:
          clauses.push({ request_put: op.req });
          break;
        case WriteKind.DeleteKey:
          clauses.push({ request_delete_range: op.req });
          break;
        case WriteKind.DeleteRange:
          clauses.push({ request_delete_range: op.req });
          break;
        default:
          throw new ClientRuntimeError(`Unexpected write op ${JSON.stringify(op)}`);
      }
    });

    cmp.then(...clauses);
  }

  /**
   * findExistingWrite returns an existing write (put or delete) against the key.
   * Returns null if no operations against it were recorded.
   */
  public findExistingWrite(key: Buffer): RPC.IRangeResponse | null {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const op = this.ops[i];
      switch (op.op) {
        case WriteKind.Write:
          if (op.req.key!.equals(key)) {
            return keyValueToResponse(key, op.req.value);
          }
          break;
        case WriteKind.DeleteKey:
          if (op.key.equals(key)) {
            return keyValueToResponse(key);
          }
          break;
        case WriteKind.DeleteRange:
          if (op.range.includes(key)) {
            return keyValueToResponse(key);
          }
          break;
        default:
          throw new ClientRuntimeError(`Unexpected write op ${JSON.stringify(op)}`);
      }
    }

    return null;
  }

  /**
   * Inserts a put operation into the set.
   */
  public addPut(put: RPC.IPutRequest) {
    this.purgeExistingOperationOn(put.key!);
    this.ops.push({ op: WriteKind.Write, req: put });
  }

  /**
   * Inserts a delete operation.
   */
  public addDeletion(req: RPC.IDeleteRangeRequest) {
    if (req.range_end) {
      this.ops.push({ req, op: WriteKind.DeleteRange, range: new Range(req.key!, req.range_end) });
    } else {
      this.purgeExistingOperationOn(req.key!);
      this.ops.push({ req, op: WriteKind.DeleteKey, key: req.key! });
    }
  }

  private purgeExistingOperationOn(key: Buffer) {
    for (let i = 0; i < this.ops.length; i++) {
      const { op, req } = this.ops[i];
      if (op === WriteKind.Write || op === WriteKind.DeleteKey) {
        if (req.key!.equals(key)) {
          this.ops.splice(i, 1);
          break;
        }
      }
    }
  }
}

/**
 * BasicTransaction is the base wrapper class for a transaction. It implements
 * the necessary mechanics for Repeatablereads
 * and ReadCommitted isolation levels.
 */
class BasicTransaction {
  public readonly writeSet = new WriteSet();
  public readonly readSet = new ReadSet();

  constructor(protected readonly options: ISTMOptions) {}

  /**
   * Gets the range in a transaction-y way!
   */
  public range(kv: RPC.KVClient, req: RPC.IRangeRequest): Promise<RPC.IRangeResponse> {
    this.assertReadInvariants(req);

    const existingWrite = this.writeSet.findExistingWrite(req.key!);
    if (existingWrite !== null) {
      return Promise.resolve(existingWrite);
    }

    req.serializable = true;
    return this.readSet.runRequest(kv, req);
  }

  /**
   * Schedules the put request in the writeSet.
   */
  public put(req: RPC.IPutRequest): Promise<RPC.IPutResponse> {
    this.assertNoOption('put', req, ['lease', 'prev_kv']);
    this.writeSet.addPut(req);
    return Promise.resolve({} as any);
  }

  /**
   * Schedules the put request in the writeSet.
   */
  public deleteRange(req: RPC.IDeleteRangeRequest): Promise<RPC.IDeleteRangeResponse> {
    this.assertNoOption('delete', req, ['prev_kv']);
    this.writeSet.addDeletion(req);
    return Promise.resolve({
      header: undefined as any,
      deleted: '1',
      prev_kvs: [],
    });
  }

  protected assertReadInvariants(range: RPC.IRangeRequest) {
    this.assertNoOption('read', range, [
      'revision',
      'range_end',
      'min_mod_revision',
      'max_mod_revision',
      'min_create_revision',
      'max_create_revision',
    ]);
  }

  protected assertNoOption<T>(req: string, obj: T, keys: Array<keyof T>) {
    keys.forEach(key => {
      if (obj[key] !== undefined) {
        throw new Error(`"${key}" is not supported in ${req} requests within STM transactions`);
      }
    });
  }
}

/**
 * BasicTransaction is the class for serializable transactions. It implements
 * the necessary mechanics for SerializableSnapshot
 * and Serializable isolation levels.
 */
class SerializableTransaction extends BasicTransaction {
  private firstRead: Promise<RPC.IRangeResponse> | null;

  constructor(options: ISTMOptions, kv: RPC.KVClient) {
    super(options);
    options.prefetch.forEach(key => {
      this.range(kv, { key: toBuffer(key) }).catch(() => undefined);
    });
  }

  /**
   * @override
   */
  public range(kv: RPC.KVClient, req: RPC.IRangeRequest): Promise<RPC.IRangeResponse> {
    this.assertReadInvariants(req);

    const existingWrite = this.writeSet.findExistingWrite(req.key!);
    if (existingWrite !== null) {
      return Promise.resolve(existingWrite);
    }

    if (!this.firstRead) {
      return (this.firstRead = this.readSet.runRequest(kv, req));
    }

    return this.firstRead.then(res => {
      req.serializable = true;
      req.revision = res.header.revision;
      return this.readSet.runRequest(kv, req);
    });
  }
}

/**
 * SoftwareTransaction is an implementation of software transaction memory,
 * described in greater detail [here](https://coreos.com/blog/transactional-memory-with-etcd3.html).
 * The idea is that you can have a block that contains multiple reads
 * and writes, then we'll commit all those changes as a single transaction,
 * automatically retrying as necessary.
 *
 * Inside the `.transact()` block, all reads and writes **must** go through
 * the transaction, not the client, or they won't be tracked.
 *
 * For example, this is a safe way to move 'money' between `bank/account1` and
 * `bank/account2`:
 *
 * ```js
 * const amount = 42;
 *
 * etcd3.stm().transact(tx => {
 *   return Promise.all([
 *     tx.get('bank/account1').number(),
 *     tx.get('bank/account2').number(),
 *   ]).then(([balance1, balance2]) => {
 *     if (balance1 < amount) {
 *       throw new Error('You do not have enough money to transfer!');
 *     }
 *
 *     return Promise.all([
 *       tx.put('bank/account1').value(balance1 - amount),
 *       tx.put('bank/account2').value(balance2 + amount),
 *     });
 *   });
 * });
 * ```
 *
 * (Note: the author does not condone using etcd for your banking infrastructure)
 */
export class SoftwareTransaction {
  private readonly kv: RPC.KVClient;
  private tx: BasicTransaction;

  constructor(
    private readonly options: ISTMOptions,
    private readonly namespace: NSApplicator,
    private readonly rawKV: RPC.KVClient,
  ) {
    this.kv = new Proxy(rawKV, {
      get: (target, key) => {
        switch (key) {
          case 'range':
            return (req: RPC.IRangeRequest) => this.tx.range(target, req);
          case 'put':
            return (req: RPC.IPutRequest) => this.tx.put(req);
          case 'deleteRange':
            return (req: RPC.IDeleteRangeRequest) => this.tx.deleteRange(req);
          default:
            throw new ClientRuntimeError(`Unexpected kv operation in STM: ${key.toString()}`);
        }
      },
    });
  }

  /**
   * transact runs the function with the current configuration. It will be
   * retried until the transaction succeeds, or until the maximum number of
   * retries has been exceeded.
   */
  public transact<T>(fn: (tx: this) => T | PromiseLike<T>): Promise<T> {
    return this.transactInner(this.options.retries, fn);
  }

  /**
   * `.get()` starts a query to look up a single key from etcd.
   */
  public get(key: string): Builder.SingleRangeBuilder {
    return new Builder.SingleRangeBuilder(this.kv, this.namespace, key);
  }

  /**
   * `.put()` starts making a put request against etcd.
   */
  public put(key: string | Buffer): Builder.PutBuilder {
    return new Builder.PutBuilder(this.kv, this.namespace, key);
  }

  /**
   * `.delete()` starts making a delete request against etcd.
   */
  public delete(): Builder.DeleteBuilder {
    return new Builder.DeleteBuilder(this.kv, this.namespace);
  }

  private transactInner<T>(retries: number, fn: (tx: this) => T | PromiseLike<T>): Promise<T> {
    this.tx =
      this.options.isolation === Isolation.Serializable ||
      this.options.isolation === Isolation.SerializableSnapshot
        ? new SerializableTransaction(this.options, this.rawKV)
        : new BasicTransaction(this.options);

    return Promise.resolve(fn(this)).then(value => {
      return this.commit()
        .then(() => value)
        .catch(err => {
          if (retries === 0 || !(err instanceof STMConflictError)) {
            throw err;
          }

          return this.transactInner(retries - 1, fn);
        });
    });
  }

  private commit(): Promise<void> {
    const cmp = new Builder.ComparatorBuilder(this.rawKV, NSApplicator.default);
    switch (this.options.isolation) {
      case Isolation.SerializableSnapshot:
        const earliestMod = this.tx.readSet
          .earliestModRevision()
          .add(1)
          .toString();
        this.tx.writeSet.addNotChangedChecks(cmp, earliestMod);
        this.tx.readSet.addCurrentChecks(cmp);
        break;
      case Isolation.Serializable:
        this.tx.readSet.addCurrentChecks(cmp);
        break;
      case Isolation.RepeatableReads:
        this.tx.readSet.addCurrentChecks(cmp);
        break;
      case Isolation.ReadCommitted:
        break; // none
      default:
        throw new Error(`Unknown isolation level "${this.options.isolation}"`);
    }

    this.tx.writeSet.addChanges(cmp);

    return cmp
      .options(this.options.callOptions)
      .commit()
      .then(result => {
        if (!result.succeeded) {
          throw new STMConflictError();
        }
      });
  }
}
