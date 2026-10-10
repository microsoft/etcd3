/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { emptyKey, endRangeForPrefix, toBuffer, zeroKey } from './util.js';

/**
 * Tests a key using etcd's range request conventions:
 * - an empty end is a point range;
 * - a zero-byte end is unbounded;
 * - all other ends are exclusive.
 */
function rangeIncludes(start: Buffer, end: Buffer, value: Buffer) {
  if (end.length === 0) {
    return start.equals(value);
  }

  return start.compare(value) <= 0 && (end.equals(zeroKey) || value.compare(end) < 0);
}

function rangeIsPoint(range: Range) {
  return range.end.length === 0;
}

function rangeIsBounded(range: Range) {
  return range.end.length !== 0 && !range.end.equals(zeroKey);
}

// Rangable is a type that can be converted into an etcd range.
export type Rangable =
  | Range
  | string
  | Buffer
  | { start: string | Buffer; end: string | Buffer }
  | { prefix: string | Buffer };

function rangableIsPrefix(r: unknown): r is { prefix: string | Buffer } {
  return typeof r === 'object' && r !== null && Object.hasOwn(r, 'prefix');
}

function rangableHasEndpoints(r: unknown): r is { start: string | Buffer; end: string | Buffer } {
  return (
    typeof r === 'object' && r !== null && Object.hasOwn(r, 'start') && Object.hasOwn(r, 'end')
  );
}

/**
 * Range represents a byte range in etcd. Parts of this class are based on the
 * logic found internally within etcd here:
 * https://github.com/coreos/etcd/blob/c4a45c57135bf49ae701352c9151dc1be433d1dd/pkg/adt/interval_tree.go
 */
export class Range {
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
    if (typeof v === 'string' || Buffer.isBuffer(v)) {
      return new Range(toBuffer(v));
    }

    if (v instanceof Range) {
      return v;
    }

    if (rangableIsPrefix(v)) {
      return Range.prefix(v.prefix);
    }

    if (rangableHasEndpoints(v)) {
      return new Range(v.start, v.end);
    }

    throw new TypeError('Invalid range');
  }
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
    return rangeIncludes(this.start, this.end, toBuffer(value));
  }

  /**
   * Compares the other range to this one, returning:
   *  -1 if this range comes before the other one
   *  1 if this range comes after the other one
   *  0 if they overlap
   */
  public compare(other: Range): number {
    if (rangeIsPoint(this)) {
      if (rangeIsPoint(other)) {
        return this.start.compare(other.start);
      }

      if (other.includes(this.start)) {
        return 0;
      }

      return this.start.compare(other.start) < 0 ? -1 : 1;
    }

    if (rangeIsPoint(other)) {
      if (this.includes(other.start)) {
        return 0;
      }

      return this.start.compare(other.start) > 0 ? 1 : -1;
    }

    if (rangeIsBounded(this) && this.end.compare(other.start) <= 0) {
      return -1;
    }

    if (rangeIsBounded(other) && other.end.compare(this.start) <= 0) {
      return 1;
    }

    return 0;
  }
}
