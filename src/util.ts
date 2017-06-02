/**
 * Converts the input to a buffer, if it is not already.
 */
export function toBuffer(input: string | Buffer): Buffer {
  if (input instanceof Buffer) {
    return input;
  }

  return Buffer.from(input);
}

/**
 * Returns items with the smallest value as picked by the `prop` function.
 */
export function minBy<T>(items: T[], prop: (x: T) => number): T[] {
  let min = prop(items[0]);
  let output = [items[0]];
  for (let i = 1; i < items.length; i++) {
    const thisMin = prop(items[i]);
    if (thisMin < min) {
      min = thisMin;
      output = [items[i]];
    } else if (thisMin === min) {
      output.push(items[i]);
    }
  }

  return output;
}

/**
 * Returns a random element from the list of items.
 */
export function sample<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Returns a promise that resolves after a certain amount of time.
 */
export function delay(duration: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(() => resolve(), duration));
}

/**
 * Implementation of lodash forOwn, with stronger typings and no dependency ;)
 */
export function forOwn<T>(obj: T, iterator: <K extends keyof T>(value: T[K], key: K) => void): void {
  const keys = <(keyof T)[]> Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    iterator(obj[keys[i]], keys[i]);
  }
}

/**
 * PromiseWrap provides promise-like functions that auto-invoke an exec
 * method when called.
 */
export abstract class PromiseWrap<T> implements PromiseLike<T> {
  /**
   * createPromise should ben override to run the promised action.
   */
  protected abstract createPromise(): Promise<T>;

  /**
   * then implements Promiselike.then()
   */
  public then<R, V>(onFulfilled: (value: T) => R | Promise<R>, onRejected?: (err: any) => V | Promise<V>): Promise<R | V> {
    return this.createPromise().then(onFulfilled, <any> onRejected);
  }

  /**
   * catch implements Promiselike.catch()
   */
  public catch<R>(onRejected: (err: any) => R | Promise<R>): Promise<R> {
    return this.createPromise().catch(onRejected);
  }
}
