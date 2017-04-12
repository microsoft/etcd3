import * as RPC from './rpc';
import { PromiseWrap } from './util';

const zeroKey = new Buffer([0]);

/**
 * prefixStart returns a buffer to start the key as a prefix.
 */
export function prefixStart(key: Buffer | string) {
  if (key.length === 0) {
    return zeroKey;
  }

  return toBuffer(key);
}

/**
 * prefixEnd returns the end of a range request, where `key` is the "start"
 * value, to get all values that share the prefix.
 */
export function prefixEnd(key: Buffer): Buffer {
  if (key.equals(zeroKey)) {
    return zeroKey;
  }

  let buffer = Buffer.from(key); // copy to prevent mutation
  for (let i = buffer.length - 1; i >= 0; i -= 0) {
    if (buffer[i] < 0xff) {
      buffer[i] = buffer[i] + 1;
      buffer = buffer.slice(0, i + 1);
      return buffer;
    }
  }

  return zeroKey;
}

/**
 * Converts the input to a buffer, if it is not already.
 */
function toBuffer(input: string | Buffer): Buffer {
  if (input instanceof Buffer) {
    return input;
  }

  return Buffer.from(input);
}

export const sortMap = {
  key: RPC.SortTarget.KEY,
  version: RPC.SortTarget.VERSION,
  createdAt: RPC.SortTarget.CREATE,
  modifiedAt: RPC.SortTarget.MOD,
  value: RPC.SortTarget.VALUE,
};

/**
 * RangeBuilder is a primitive builder for range queries on the kv store.
 * It's extended by the Single and MultiRangeBuilders, which contain
 * the concrete methods to execute the built query.
 */
export abstract class RangeBuilder extends PromiseWrap<RPC.IRangeResponse> {
  protected request: RPC.IRangeRequest = {};

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
}

/**
 * SingleRangeBuilder is a query builder that looks up a single key.
 */
export class SingleRangeBuilder extends RangeBuilder {
  constructor(private kv: RPC.KVClient, key: string | Buffer) {
    super();
    this.request.key = toBuffer(key);
    this.request.limit = 1;
  }

  /**
   * Runs the built request and parses the returned key as JSON,
   * or returns `null` if it isn't found.
   */
  public json(): Promise<any> {
    return this.string().then(value => value === null ? null : JSON.parse(value));
  }

  /**
   * Runs the built request and returns the value of the returned key as a
   * string, or `null` if it isn't found.
   */
  public string(): Promise<string | null> {
    return this.exec().then(res => res.kvs.length === 0 ? null : res.kvs[0].value.toString());
  }

  /**
   * Runs the built request and returns the value of the returned key as a
   * buffer, or `null` if it isn't found.
   */
  public buffer(): Promise<Buffer | null> {
    return this.exec().then(res => res.kvs.length === 0 ? null : res.kvs[0].value);
  }

  /**
   * Runs the built request and returns the raw response from etcd.
   */
  public exec(): Promise<RPC.IRangeResponse> {
    return this.kv.range(this.request);
  }
}

/**
 * MultiRangeBuilder is a query builder that looks up multiple keys.
 */
export class MultiRangeBuilder extends RangeBuilder {
  constructor(private kv: RPC.KVClient) {
    super();
    this.prefix('');
  }

  /**
   * Prefix instructs the query to scan for all keys that have the provided prefix.
   */
  public prefix(value: string | Buffer): this {
    this.request.key = prefixStart(value);
    this.request.range_end = prefixEnd(this.request.key);
    return this;
  }

  /**
   * All will instruct etcd to get all keys.
   */
  public all(): this {
    return this.prefix('');
  }

  /**
   * inRange instructs the builder to get keys in the specified byte range.
   */
  public inRange(start: string | Buffer, end: string | Buffer): this {
    this.request.key = toBuffer(start);
    this.request.range_end = toBuffer(end);
    return this;
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
  public sort(target: keyof typeof sortMap, order: 'asc' | 'desc'): this {
    this.request.sort_target = sortMap[target];
    this.request.sort_order = order.toLowerCase() === 'asc' ? RPC.SortOrder.ASCEND : RPC.SortOrder.DESCEND;
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
   * keys returns the keys in etcd that match the query.
   */
  public keys(): Promise<string[]> {
    this.request.keys_only = true;
    return this.exec().then(res => res.kvs.map(kv => kv.key.toString()));
  }

  /**
   * Runs the built request and parses the returned keys as JSON.
   */
  public json(): Promise<any> {
    return this.exec().then(res => res.kvs.map(kv => JSON.stringify(kv.value)));
  }

  /**
   * Runs the built request and returns the value of the returned key as a
   * string, or `null` if it isn't found.
   */
  public strings(): Promise<string[]> {
    return this.exec().then(res => res.kvs.map(kv => kv.value.toString()));
  }

  /**
   * Runs the built request and returns the value of the returned key as a
   * buffers.
   */
  public buffers(): Promise<Buffer[]> {
    return this.exec().then(res => res.kvs.map(kv => kv.value));
  }

  /**
   * Runs the built request and returns the raw response from etcd.
   */
  public exec(): Promise<RPC.IRangeResponse> {
    return this.kv.range(this.request);
  }
}

/**
 * DeleteBuilder builds a deletion.
 */
export class DeleteBuilder extends PromiseWrap<RPC.IDeleteRangeResponse> {
  private request: RPC.IDeleteRangeRequest = {};

  constructor(private kv: RPC.KVClient) {
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
   * Prefix instructs the query to delete all keys that have the provided prefix.
   */
  public prefix(value: string | Buffer): this {
    this.request.key = prefixStart(value);
    this.request.range_end = prefixEnd(this.request.key);
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
  public inRange(start: string | Buffer, end: string | Buffer): this {
    this.request.key = toBuffer(start);
    this.request.range_end = toBuffer(end);
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
    return this.kv.deleteRange(this.request);
  }
}

/**
 * PutBuilder builds a "put" request to etcd.
 */
export class PutBuilder extends PromiseWrap<RPC.IPutResponse> {
  private request: RPC.IPutRequest = {};

  constructor(private kv: RPC.KVClient, key: string | Buffer) {
    super();
    this.request.key = toBuffer(key);
  }

  /**
   * value sets the value that will be stored in the key.
   */
  public value(value: string | Buffer): this {
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
    return this.kv.put(this.request);
  }
}
