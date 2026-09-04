/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { describe, expect, it } from 'vitest';
import { Range } from '../range';

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
  });
});
