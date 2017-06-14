import { emptyKey, endRangeForPrefix, toBuffer, zeroKey } from './util';

function compare(a: Buffer, b: Buffer) {
  if (a.length === 0) {
    return b.length === 0 ? 0 : 1;
  }
  if (b.length === 0) {
    return -1;
  }

  return a.compare(b);
}

// Rangable is a type that can be converted into an etcd range.
export type Rangable =
  | Range
  | string
  | Buffer
  | { start: string | Buffer; end: string | Buffer }
  | { prefix: string | Buffer };

function rangableIsPrefix(r: Rangable): r is { prefix: string | Buffer } {
  return r.hasOwnProperty('prefix');
}

/**
 * Range represents a byte range in etcd. Parts of this class are based on the
 * logic found internally within etcd here:
 * https://github.com/coreos/etcd/blob/c4a45c57135bf49ae701352c9151dc1be433d1dd/pkg/adt/interval_tree.go
 */
export class Range {
  public readonly start: Buffer;
  public readonly end: Buffer;

  constructor(start: Buffer | string, end: Buffer | string = emptyKey) {
    this.start = toBuffer(start);
    this.end = toBuffer(end);
  }

  /**
   * Returns whether the byte range includes the provided value.
   */
  public includes(value: string | Buffer) {
    value = toBuffer(value);
    return compare(this.start, value) <= 0 && compare(this.end, value) > 0;
  }

  /**
   * Compares the other range to this one, returning:
   *  -1 if this range comes before the other one
   *  1 if this range comes after the other one
   *  0 if they overlap
   */
  public compare(other: Range): number {
    const ivbCmpBegin = compare(this.start, other.start);
    const ivbCmpEnd = compare(this.start, other.end);
    const iveCmpBegin = compare(this.end, other.start);

    if (ivbCmpBegin < 0 && iveCmpBegin <= 0) {
      return -1;
    }

    if (ivbCmpEnd >= 0) {
      return 1;
    }

    return 0;
  }

  /**
   * Prefix returns a Range that maps to all keys
   * prefixed with the provided string.
   */
  public static prefix(prefix: string | Buffer) {
    if (prefix.length === 0) {
      return new Range(zeroKey, zeroKey);
    }

    return new Range(prefix, endRangeForPrefix(toBuffer(prefix)));
  }

  /**
   * Converts a rangable into a qualified Range.
   */
  public static from(v: Rangable): Range {
    if (typeof v === 'string' || v instanceof Buffer) {
      return new Range(toBuffer(v));
    }

    if (v instanceof Range) {
      return v;
    }

    if (rangableIsPrefix(v)) {
      return Range.prefix(v.prefix);
    }

    return new Range(v.start, v.end);
  }
}
