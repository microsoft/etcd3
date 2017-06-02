import { expect } from 'chai';
import { Range } from '../src/range';

describe('Range', () => {
  describe('prefix', () => {
    it('generates prefixes for an empty string', () => {
      const range = Range.prefix(Buffer.from([]));
      expect(range.start).to.deep.equal(Buffer.from([0]));
      expect(range.end).to.deep.equal(Buffer.from([0]));
    });

    it('generates prefixes for a "normal" string', () => {
      const range = Range.prefix(Buffer.from([1, 2]));
      expect(range.start).to.deep.equal(Buffer.from([1, 2]));
      expect(range.end).to.deep.equal(Buffer.from([1, 3]));
    });

    it('rolls on a high end-bit', () => {
      const range = Range.prefix(Buffer.from([1, 255]));
      expect(range.start).to.deep.equal(Buffer.from([1, 255]));
      expect(range.end).to.deep.equal(Buffer.from([2]));
    });

    it('aborts on all high bits', () => {
      const range = Range.prefix(Buffer.from([255, 255]));
      expect(range.start).to.deep.equal(Buffer.from([255, 255]));
      expect(range.end).to.deep.equal(Buffer.from([0]));
    });
  });

  describe('comparisons', () => {
    const prefix: Buffer[] = [];
    for (let i = 0; i < 10; i += 1) {
      prefix.push(Buffer.from([i]));
    }

    it('compares ranges', () => {
      const r = new Range(prefix[2], prefix[5]);
      expect(r.compare(new Range(prefix[2], prefix[5]))).to.equal(0);
      expect(r.compare(new Range(prefix[3], prefix[6]))).to.equal(0);
      expect(r.compare(new Range(prefix[0], prefix[4]))).to.equal(0);
      expect(r.compare(new Range(prefix[0], prefix[9]))).to.equal(0);
      expect(r.compare(new Range(prefix[3], prefix[4]))).to.equal(0);
      expect(r.compare(new Range(prefix[5], prefix[7]))).to.equal(-1);
      expect(r.compare(new Range(prefix[0], prefix[1]))).to.equal(1);
    });

    it('checks if a key is included', () => {
      const r = new Range(prefix[2], prefix[5]);
      expect(r.includes(prefix[1])).to.be.false;
      expect(r.includes(prefix[2])).to.be.true;
      expect(r.includes(prefix[5])).to.be.false;
    });
  });
});
