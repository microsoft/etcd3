import { Rangable, Range } from './range';
import * as RPC from './rpc';
import { NSApplicator, PromiseWrap, toBuffer } from './util';

const emptyBuffer = Buffer.from([]);

/**
 * Comparators can be passed to various operations in the ComparatorBuilder.
 */
export const comparator = {
  '==': RPC.CompareResult.Equal,
  '===': RPC.CompareResult.Equal,
  '>': RPC.CompareResult.Greater,
  '<': RPC.CompareResult.Less,
  '!=': RPC.CompareResult.NotEqual,
  '!==': RPC.CompareResult.NotEqual,
};

export interface ICompareTarget {
  value: RPC.CompareTarget;
  key: keyof RPC.ICompare;
}

export interface IOperation {
  op(): RPC.IRequestOp;
}

/**
 * compareTarget are the types of things that can be compared against.
 */
export const compareTarget: { [key in keyof typeof RPC.CompareTarget]: keyof RPC.ICompare } = {
  Value: 'value',
  Version: 'version',
  Create: 'create_revision',
  Mod: 'mod_revision',
  Lease: 'lease',
};

/**
 * assertWithin throws a helpful error message if the value provided isn't
 * a key in the given map.
 */
function assertWithin<T>(map: T, value: keyof T, thing: string) {
  if (!(value in map)) {
    const keys = Object.keys(map).join('" "');
    throw new Error(`Unexpected "${value}" in ${thing}. Possible values are: "${keys}"`);
  }
}

/**
 * RangeBuilder is a primitive builder for range queries on the kv store.
 * It's extended by the Single and MultiRangeBuilders, which contain
 * the concrete methods to execute the built query.
 */
export abstract class RangeBuilder<T> extends PromiseWrap<T> implements IOperation {
  protected request: RPC.IRangeRequest = {};

  constructor(protected readonly namespace: NSApplicator) {
    super();
  }

  /**
   * revision is the point-in-time of the key-value store to use for the range.
   */
  public revision(rev: number | string): this {
    this.request.revision = rev;
    return this;
  }

  /**
   * serializable sets the range request to use serializable member-local reads.
   */
  public serializable(serializable: boolean): this {
    this.request.serializable = serializable;
    return this;
  }

  /**
   * minModRevision sets the minimum modified revision of keys to return.
   */
  public minModRevision(minModRevision: number | string): this {
    this.request.min_mod_revision = minModRevision;
    return this;
  }

  /**
   * maxModRevision sets the maximum modified revision of keys to return.
   */
  public maxModRevision(maxModRevision: number | string): this {
    this.request.max_mod_revision = maxModRevision;
    return this;
  }

  /**
   * minCreateRevision sets the minimum create revision of keys to return.
   */
  public minCreateRevision(minCreateRevision: number | string): this {
    this.request.min_create_revision = minCreateRevision;
    return this;
  }

  /**
   * maxCreateRevision sets the maximum create revision of keys to return.
   */
  public maxCreateRevision(maxCreateRevision: number | string): this {
    this.request.max_create_revision = maxCreateRevision;
    return this;
  }

  /**
   * Returns the request op for this builder, used in transactions.
   */
  public op(): RPC.IRequestOp {
    return { request_range: this.namespace.applyToRequest(this.request) };
  }
}

/**
 * SingleRangeBuilder is a query builder that looks up a single key.
 */
export class SingleRangeBuilder extends RangeBuilder<string | null> {
  constructor(private readonly kv: RPC.KVClient, namespace: NSApplicator, key: string | Buffer) {
    super(namespace);
    this.request.key = toBuffer(key);
    this.request.limit = 1;
  }

  /**
   * Runs the built request and parses the returned key as JSON,
   * or returns `null` if it isn't found.
   */
  public json(): Promise<object> {
    return this.string().then(JSON.parse);
  }

  /**
   * Runs the built request and returns the value of the returned key as a
   * string, or `null` if it isn't found.
   */
  public string(encoding: string = 'utf8'): Promise<string | null> {
    return this.exec().then(
      res => (res.kvs.length === 0 ? null : res.kvs[0].value.toString(encoding)),
    );
  }

  /**
   * Runs the built request, and returns the value parsed as a number. Resolves
   * as NaN if the value can't be parsed as a number.
   */
  public number(): Promise<number | null> {
    return this.string().then(value => (value === null ? null : Number(value)));
  }

  /**
   * Runs the built request and returns the value of the returned key as a
   * buffer, or `null` if it isn't found.
   */
  public buffer(): Promise<Buffer | null> {
    return this.exec().then(res => (res.kvs.length === 0 ? null : res.kvs[0].value));
  }

  /**
   * Runs the built request and returns the raw response from etcd.
   */
  public exec(): Promise<RPC.IRangeResponse> {
    return this.kv.range(this.namespace.applyToRequest(this.request));
  }

  /**
   * @override
   */
  protected createPromise(): Promise<string | null> {
    return this.string();
  }
}

/**
 * MultiRangeBuilder is a query builder that looks up multiple keys.
 */
export class MultiRangeBuilder extends RangeBuilder<{ [key: string]: string }> {
  constructor(private readonly kv: RPC.KVClient, namespace: NSApplicator) {
    super(namespace);
    this.prefix(emptyBuffer);
  }

  /**
   * Prefix instructs the query to scan for all keys that have the provided
   * prefix.
   */
  public prefix(value: string | Buffer): this {
    return this.inRange(Range.prefix(value));
  }

  /**
   * inRange instructs the builder to get keys in the specified byte range.
   */
  public inRange(r: Rangable): this {
    const range = Range.from(r);
    this.request.key = range.start;
    this.request.range_end = range.end;
    return this;
  }

  /**
   * All will instruct etcd to get all keys.
   */
  public all(): this {
    return this.prefix('');
  }

  /**
   * Limit sets the maximum number of results to retrieve.
   */
  public limit(count: number): this {
    this.request.limit = isFinite(count) ? count : 0;
    return this;
  }

  /**
   * Sort specifies how the result should be sorted.
   */
  public sort(target: keyof typeof RPC.SortTarget, order: keyof typeof RPC.SortOrder): this {
    assertWithin(RPC.SortTarget, target, 'sort order in client.get().sort(...)');
    assertWithin(RPC.SortOrder, order, 'sort order in client.get().sort(...)');
    this.request.sort_target = RPC.SortTarget[target];
    this.request.sort_order = RPC.SortOrder[order];
    return this;
  }

  /**
   * count returns the number of keys that match the query.
   */
  public count(): Promise<number> {
    this.request.count_only = true;
    return this.exec().then(res => Number(res.count));
  }

  /**
   * Keys returns an array of keys matching the query.
   */
  public keys(encoding: string = 'utf8'): Promise<string[]> {
    this.request.keys_only = true;
    return this.exec().then(res => {
      return res.kvs.map(kv => kv.key.toString(encoding));
    });
  }

  /**
   * Keys returns an array of keys matching the query, as buffers.
   */
  public keyBuffers(): Promise<Buffer[]> {
    this.request.keys_only = true;
    return this.exec().then(res => {
      return res.kvs.map(kv => kv.key);
    });
  }

  /**
   * Runs the built request and parses the returned keys as JSON.
   */
  public json(): Promise<{ [key: string]: object }> {
    return this.mapValues(buf => JSON.parse(buf.toString()));
  }

  /**
   * Runs the built request and returns the value of the returned key as a
   * string, or `null` if it isn't found.
   */
  public strings(encoding: string = 'utf8'): Promise<{ [key: string]: string }> {
    return this.mapValues(buf => buf.toString(encoding));
  }

  /**
   * Runs the built request and returns the values of keys as numbers. May
   * resolve to NaN if the keys do not contain numbers.
   */
  public numbers(): Promise<{ [key: string]: number }> {
    return this.mapValues(buf => Number(buf.toString()));
  }

  /**
   * Runs the built request and returns the value of the returned key as a
   * buffers.
   */
  public buffers(): Promise<{ [key: string]: Buffer }> {
    return this.mapValues(b => b);
  }

  /**
   * Runs the built request and returns the raw response from etcd.
   */
  public exec(): Promise<RPC.IRangeResponse> {
    return this.kv.range(this.namespace.applyToRequest(this.request)).then(res => {
      for (let i = 0; i < res.kvs.length; i++) {
        res.kvs[i].key = this.namespace.unprefix(res.kvs[i].key);
      }

      return res;
    });
  }

  /**
   * @override
   */
  protected createPromise(): Promise<{ [key: string]: string }> {
    return this.strings();
  }

  /**
   * Dispatches a call to the server, and creates a map by running the
   * iterator over the values returned.
   */
  private mapValues<T>(iterator: (buf: Buffer) => T): Promise<{ [key: string]: T }> {
    return this.exec().then(res => {
      const output: { [key: string]: T } = {};
      for (let i = 0; i < res.kvs.length; i++) {
        output[res.kvs[i].key.toString()] = iterator(res.kvs[i].value);
      }

      return output;
    });
  }
}

/**
 * DeleteBuilder builds a deletion.
 */
export class DeleteBuilder extends PromiseWrap<RPC.IDeleteRangeResponse> {
  private request: RPC.IDeleteRangeRequest = {};

  constructor(private readonly kv: RPC.KVClient, private readonly namespace: NSApplicator) {
    super();
  }

  /**
   * key sets a single key to be deleted.
   */
  public key(value: string | Buffer): this {
    this.request.key = toBuffer(value);
    this.request.range_end = undefined;
    return this;
  }

  /**
   * key sets a single key to be deleted.
   */
  public prefix(value: string | Buffer): this {
    return this.range(Range.prefix(value));
  }

  /**
   * Sets the byte range of values to delete.
   */
  public range(range: Range): this {
    this.request.key = range.start;
    this.request.range_end = range.end;
    return this;
  }

  /**
   * All will instruct etcd to wipe all keys.
   */
  public all(): this {
    return this.prefix('');
  }

  /**
   * inRange instructs the builder to delete keys in the specified byte range.
   */
  public inRange(r: Rangable): this {
    const range = Range.from(r);
    this.request.key = range.start;
    this.request.range_end = range.end;
    return this;
  }

  /**
   * getPrevious instructs etcd to *try* to get the previous value of the
   * key before setting it. One may not always be available if a compaction
   * takes place.
   */
  public getPrevious(): Promise<RPC.IKeyValue[]> {
    this.request.prev_kv = true;
    return this.exec().then(res => res.prev_kvs);
  }
  /**
   * exec runs the delete put request.
   */
  public exec(): Promise<RPC.IDeleteRangeResponse> {
    return this.kv.deleteRange(this.namespace.applyToRequest(this.request));
  }

  /**
   * Returns the request op for this builder, used in transactions.
   */
  public op(): RPC.IRequestOp {
    return {
      request_delete_range: this.namespace.applyToRequest(this.request),
    };
  }

  /**
   * @override
   */
  protected createPromise(): Promise<RPC.IDeleteRangeResponse> {
    return this.exec();
  }
}

/**
 * PutBuilder builds a "put" request to etcd.
 */
export class PutBuilder extends PromiseWrap<RPC.IPutResponse> {
  private request: RPC.IPutRequest = {};

  constructor(
    private readonly kv: RPC.KVClient,
    private readonly namespace: NSApplicator,
    key: string | Buffer,
  ) {
    super();
    this.request.key = toBuffer(key);
  }

  /**
   * value sets the value that will be stored in the key.
   */
  public value(value: string | Buffer | number): this {
    this.request.value = toBuffer(value);
    return this;
  }

  /**
   * Sets the lease value to use for storing the key. You usually don't
   * need to use this directly, use `client.lease()` instead!
   */
  public lease(lease: number | string): this {
    this.request.lease = lease;
    return this;
  }

  /**
   * Updates the key on its current lease, regardless of what that lease is.
   */
  public ignoreLease(): this {
    this.request.ignore_lease = true;
    return this;
  }

  /**
   * getPrevious instructs etcd to *try* to get the previous value of the
   * key before setting it. One may not always be available if a compaction
   * takes place.
   */
  public getPrevious(): Promise<RPC.IKeyValue & { header: RPC.IResponseHeader }> {
    this.request.prev_kv = true;
    return this.exec().then(res => ({ ...res.prev_kv, header: res.header }));
  }

  /**
   * Touch updates the key's revision without changing its value. This is
   * equivalent to the etcd 'ignore value' flag.
   */
  public touch(): Promise<RPC.IPutResponse> {
    this.request.value = undefined;
    this.request.ignore_value = true;
    return this.exec();
  }

  /**
   * exec runs the put request.
   */
  public exec(): Promise<RPC.IPutResponse> {
    return this.kv.put(this.namespace.applyToRequest(this.request));
  }

  /**
   * Returns the request op for this builder, used in transactions.
   */
  public op(): RPC.IRequestOp {
    return { request_put: this.namespace.applyToRequest(this.request) };
  }

  /**
   * @override
   */
  protected createPromise(): Promise<RPC.IPutResponse> {
    return this.exec();
  }
}

/**
 * ComparatorBuilder builds a comparison between keys. This can be used
 * for atomic operations in etcd, such as locking:
 *
 * ```
 * const id = uuid.v4();
 *
 * function lock() {
 *   return client.if('my_lock', 'Create', '==', 0)
 *     .then(client.put('my_lock').value(id))
 *     .else(client.get('my_lock'))
 *     .commit()
 *     .then(result => console.log(result.succeeded === id ? 'lock acquired' : 'already locked'));
 * }
 *
 * function unlock() {
 *   return client.if('my_lock', 'Value', '==', id)
 *     .then(client.delete().key('my_lock'))
 *     .commit();
 * }
 * ```
 */
export class ComparatorBuilder {
  private request: RPC.ITxnRequest = {};

  constructor(private readonly kv: RPC.KVClient, private readonly namespace: NSApplicator) {}

  /**
   * Adds a new clause to the transaction.
   */
  public and(
    key: string | Buffer,
    column: keyof typeof RPC.CompareTarget,
    cmp: keyof typeof comparator,
    value: string | Buffer | number,
  ): this {
    assertWithin(compareTarget, column, 'comparison target in client.and(...)');
    assertWithin(comparator, cmp, 'comparator in client.and(...)');

    if (column === 'Value') {
      value = toBuffer(<string | Buffer>value);
    }

    this.request.compare = this.request.compare || [];
    this.request.compare.push({
      key: this.namespace.applyKey(toBuffer(key)),
      result: comparator[cmp],
      target: RPC.CompareTarget[column],
      [compareTarget[column]]: value,
    });
    return this;
  }

  /**
   * Adds one or more consequent clauses to be executed if the comparison
   * is truthy.
   */
  public then(...clauses: (RPC.IRequestOp | IOperation)[]): this {
    this.request.success = this.mapOperations(clauses);
    return this;
  }

  /**
   * Adds one or more consequent clauses to be executed if the comparison
   * is falsey.
   */
  public else(...clauses: (RPC.IRequestOp | IOperation)[]): this {
    this.request.failure = this.mapOperations(clauses);
    return this;
  }

  /**
   * Runs the generated transaction and returns its result.
   */
  public commit(): Promise<RPC.ITxnResponse> {
    return this.kv.txn(this.request);
  }

  /**
   * Low-level method to add
   */
  public mapOperations(ops: (RPC.IRequestOp | IOperation)[]): RPC.IRequestOp[] {
    return ops.map(op => {
      if (typeof (<IOperation>op).op === 'function') {
        return (<IOperation>op).op();
      }

      return <RPC.IRequestOp>op;
    });
  }
}
