/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { describe, expect, it } from 'vitest';
import { Range } from '../range.js';

describe('Range', () => {
  describe('prefix', () => {
    it('generates prefixes for an empty string', () => {
      const range = Range.prefix(Buffer.from([]));
      expect(range.start).toEqual(Buffer.from([0]));
      expect(range.end).toEqual(Buffer.from([0]));
    });

    it('generates prefixes for a "normal" string', () => {
      const range = Range.prefix(Buffer.from([1, 2]));
      expect(range.start).toEqual(Buffer.from([1, 2]));
      expect(range.end).toEqual(Buffer.from([1, 3]));
    });

    it('rolls on a high end-bit', () => {
      const range = Range.prefix(Buffer.from([1, 255]));
      expect(range.start).toEqual(Buffer.from([1, 255]));
      expect(range.end).toEqual(Buffer.from([2]));
    });

    it('aborts on all high bits', () => {
      const range = Range.prefix(Buffer.from([255, 255]));
      expect(range.start).toEqual(Buffer.from([255, 255]));
      expect(range.end).toEqual(Buffer.from([0]));
    });
  });

  describe('comparisons', () => {
    const prefix: Buffer[] = [];
    for (let i = 0; i < 10; i += 1) {
      prefix.push(Buffer.from([i]));
    }

    it('compares ranges', () => {
      const r = new Range(prefix[2], prefix[5]);
      expect(r.compare(new Range(prefix[2], prefix[5]))).toBe(0);
      expect(r.compare(new Range(prefix[3], prefix[6]))).toBe(0);
      expect(r.compare(new Range(prefix[0], prefix[4]))).toBe(0);
      expect(r.compare(new Range(prefix[0], prefix[9]))).toBe(0);
      expect(r.compare(new Range(prefix[3], prefix[4]))).toBe(0);
      expect(r.compare(new Range(prefix[5], prefix[7]))).toBe(-1);
      expect(r.compare(new Range(prefix[0], prefix[1]))).toBe(1);
    });

    it('checks if a key is included', () => {
      const r = new Range(prefix[2], prefix[5]);
      expect(r.includes(prefix[1])).toBe(false);
      expect(r.includes(prefix[2])).toBe(true);
      expect(r.includes(prefix[5])).toBe(false);
    });

    it('models empty ends as point ranges', () => {
      const point = new Range(Buffer.from([0x61, 0x80]));

      expect(point.includes(Buffer.from([0x61, 0x80]))).toBe(true);
      expect(point.includes(Buffer.from([0x61, 0x7f]))).toBe(false);
      expect(point.includes(Buffer.from([0x61, 0x80, 0x00]))).toBe(false);
      expect(point.compare(new Range(Buffer.from([0x61, 0x80])))).toBe(0);
      expect(point.compare(new Range(Buffer.from([0x61, 0x81])))).toBe(-1);
      expect(point.compare(new Range(Buffer.from([0x61, 0x7f])))).toBe(1);
    });

    it('compares points and bounded half-open ranges at arbitrary byte boundaries', () => {
      const range = new Range(Buffer.from([0x61, 0x80]), Buffer.from([0x61, 0xff]));

      expect(range.includes(Buffer.from([0x61, 0x80]))).toBe(true);
      expect(range.includes(Buffer.from([0x61, 0xfe, 0xff]))).toBe(true);
      expect(range.includes(Buffer.from([0x61, 0xff]))).toBe(false);
      expect(new Range(Buffer.from([0x61, 0x7f])).compare(range)).toBe(-1);
      expect(new Range(Buffer.from([0x61, 0x80])).compare(range)).toBe(0);
      expect(new Range(Buffer.from([0x61, 0xff])).compare(range)).toBe(1);
      expect(range.compare(new Range(Buffer.from([0x61, 0x7f])))).toBe(1);
      expect(range.compare(new Range(Buffer.from([0x61, 0x80])))).toBe(0);
      expect(range.compare(new Range(Buffer.from([0x61, 0xfe, 0xff])))).toBe(0);
      expect(range.compare(new Range(Buffer.from([0x61, 0xff])))).toBe(-1);
      expect(range.compare(new Range(Buffer.from([0x61, 0xff]), Buffer.from([0x62])))).toBe(-1);
    });

    it('uses a zero-byte end as the unbounded etcd sentinel', () => {
      const unbounded = new Range(Buffer.from([0x80]), Buffer.from([0]));
      const wholeKeyspace = Range.prefix(Buffer.alloc(0));

      expect(unbounded.includes(Buffer.from([0x80]))).toBe(true);
      expect(unbounded.includes(Buffer.from([0xff, 0xff]))).toBe(true);
      expect(unbounded.includes(Buffer.from([0x7f, 0xff]))).toBe(false);
      expect(unbounded.compare(new Range(Buffer.from([0xff, 0xff])))).toBe(0);
      expect(unbounded.compare(new Range(Buffer.from([0x7f]), Buffer.from([0x80])))).toBe(1);
      expect(wholeKeyspace.includes(Buffer.from([0]))).toBe(true);
      expect(wholeKeyspace.includes(Buffer.from([0xff, 0xff]))).toBe(true);
    });
  });
});
