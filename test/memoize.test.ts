import { expect } from 'chai';
import { forget, Memoize } from '../src/memoize';

class Foo {
  public incr = 0;

  @Memoize()
  public get incrGetter(): number {
    this.incr += 1;
    return this.incr;
  }

  @Memoize()
  public basicMemoized(amount: number): number {
    this.incr += amount;
    return this.incr;
  }

  @Memoize((value: number) => value % 2)
  public byModulo(amount: number): number {
    this.incr += amount;
    return this.incr;
  }

  public forgetBasic() {
    forget(this, this.basicMemoized);
  }
}

describe('@Memoize', () => {
  it('memoizes simple methods', () => {
    const foo = new Foo();
    expect(foo.basicMemoized(1)).to.equal(1);
    expect(foo.basicMemoized(1)).to.equal(1);
    expect(foo.basicMemoized(2)).to.equal(3);
  });
  it('forgets memoized values', () => {
    const foo = new Foo();
    expect(foo.basicMemoized(1)).to.equal(1);
    foo.forgetBasic();
    expect(foo.basicMemoized(1)).to.equal(2);
    expect(foo.basicMemoized(1)).to.equal(2);
  });

  it('memoizes with custom hashers', () => {
    const foo = new Foo();
    expect(foo.incr).to.equal(0);
    expect(foo.byModulo(1)).to.equal(1);
    expect(foo.byModulo(2)).to.equal(3);
    expect(foo.byModulo(3)).to.equal(1);
    expect(foo.byModulo(4)).to.equal(3);
  });

  it('memoizes getters', () => {
    const foo = new Foo();
    expect(foo.incrGetter).to.equal(1);
    expect(foo.incrGetter).to.equal(1);
  });

  it('throws when attaching to a non-memoizable type', () => {
    expect(() => {
      class Bar {
        @Memoize()
        public set foo(_value: number) { /* noop */ }
      }
      return Bar;
    }).to.throw(/Can only attach/);
  });
});
