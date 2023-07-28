/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { CallOptions } from '@grpc/grpc-js';
import { EventEmitter } from 'events';
import { ClientRuntimeError } from './errors';
import { CallOptionsFactory } from './options';
import { CallContext, Services } from './rpc';

export const zeroKey = Buffer.from([0]);
export const emptyKey = Buffer.from([]);

/**
 * Converts the input to a buffer, if it is not already.
 */
export function toBuffer(input: string | Buffer | number): Buffer {
  if (input instanceof Buffer) {
    return input;
  }
  if (typeof input === 'number') {
    input = String(input);
  }

  return Buffer.from(input);
}

/**
 * Returns the range_end value for a query for the provided prefix.
 */
export function endRangeForPrefix(prefix: Buffer): Buffer {
  const start = toBuffer(prefix);
  let end = Buffer.from(start); // copy to prevent mutation
  for (let i = end.length - 1; i >= 0; i--) {
    if (end[i] < 0xff) {
      end[i]++;
      end = end.slice(0, i + 1);
      return end;
    }
  }

  return zeroKey;
}

/**
 * NSApplicator is used internally to apply a namespace to a given request. It
 * can only be used for a single application.
 */
export class NSApplicator {
  /**
   * Creates a new no-op namespace applicator.
   */
  public static readonly default = new NSApplicator(emptyKey);

  // A little caching, maybe a microoptimization :P
  private endRange: Buffer | null;

  constructor(private readonly prefix: Buffer) {}

  /**
   * Applies the namespace prefix to the buffer, if it exists.
   */
  public applyKey(buf?: Buffer) {
    if (this.prefix.length === 0 || !buf) {
      return buf;
    }

    return Buffer.concat([this.prefix, buf]);
  }

  /**
   * Applies the namespace prefix to a range end. Due to how etcd handle 'zero'
   * ranges, we need special logic here.
   */
  public applyRangeEnd(buf?: Buffer) {
    if (this.prefix.length === 0 || !buf) {
      return buf;
    }

    if (buf.equals(zeroKey)) {
      if (!this.endRange) {
        this.endRange = endRangeForPrefix(this.prefix);
      }

      return this.endRange;
    }

    return Buffer.concat([this.prefix, buf]);
  }

  /**
   * Shortcut function to apply the namespace to a GRPC CRUD request. It returns
   * a new request, it does not modify the original.
   */
  public applyToRequest<T extends { key?: Buffer; range_end?: Buffer }>(req: T): T {
    if (this.prefix.length === 0) {
      return req;
    }

    // TS doesn't seem to like the spread operator on generics, so O.A it is.
    return Object.assign({}, req, {
      key: this.applyKey(req.key),
      range_end: this.applyRangeEnd(req.range_end),
    });
  }

  /**
   * Removes a namespace prefix from the provided buffer. Throws if the buffer
   * doesn't have the prefix.
   */
  public unprefix(buf: Buffer): Buffer {
    if (this.prefix.length === 0) {
      return buf;
    }

    if (!buf.slice(0, this.prefix.length).equals(this.prefix)) {
      throw new ClientRuntimeError(`Cannot slice non-existent prefix ${this.prefix} from ${buf}!`);
    }

    return buf.slice(this.prefix.length);
  }
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
  return new Promise<void>(resolve => setTimeout(resolve, duration));
}

/**
 * Implementation of lodash forOwn, with stronger typings and no dependency ;)
 */
export function forOwn<T extends object>(
  obj: T,
  iterator: <K extends keyof T>(value: T[K], key: K) => void,
): void {
  const keys = Object.keys(obj) as (keyof T)[];
  for (const key of keys) {
    iterator(obj[key], key);
  }
}

/**
 * onceEvent returns a promise that resolves once any of the listed events
 * fire on the emitter.
 */
export function onceEvent(emitter: EventEmitter, ...events: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const teardown: (() => void)[] = [];

    const handler = (data: any, event: string) => {
      teardown.forEach(t => t());
      if (event === 'error') {
        reject(data);
      } else {
        resolve(data);
      }
    };

    events.forEach(event => {
      const fn = (data: any) => handler(data, event);
      teardown.push(() => emitter.removeListener(event, fn));
      emitter.once(event, fn);
    });
  });
}

/**
 * A trailing-edge debounce function.
 */
export function debounce(duration: number, fn: () => void) {
  let timeout: NodeJS.Timeout | undefined;

  const wrapper = () => {
    wrapper.cancel();
    timeout = setTimeout(fn, duration);
  };

  wrapper.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  return wrapper;
}

/**
 * PromiseWrap provides promise-like functions that auto-invoke an exec
 * method when called.
 */
export abstract class PromiseWrap<T> implements PromiseLike<T> {
  /**
   * then implements Promiselike.then()
   */
  public then<R, V>(
    onFulfilled: (value: T) => R | Promise<R>,
    onRejected?: (err: any) => V | Promise<V>,
  ): Promise<R | V> {
    return this.createPromise().then(onFulfilled, onRejected as any);
  }

  /**
   * catch implements Promiselike.catch()
   */
  public catch<R>(onRejected: (err: any) => R | Promise<R>): Promise<T | R> {
    return this.createPromise().catch(onRejected);
  }

  /**
   * createPromise should ben override to run the promised action.
   */
  protected abstract createPromise(): Promise<T>;
}

export interface ICallContext {
  service: keyof typeof Services;
  method: string;
  params: unknown;
}

/**
 * Applies the defaultOptions or defaultOptions factory to the given
 * call-specific options.
 */
export const resolveCallOptions = (
  callOptions: CallOptions | undefined,
  defaultOptions: undefined | CallOptionsFactory,
  context: CallContext,
): CallOptions | undefined => {
  if (defaultOptions === undefined) {
    return callOptions;
  }

  if (typeof defaultOptions === 'function') {
    defaultOptions = defaultOptions(context);
  }

  return callOptions ? { ...defaultOptions, ...callOptions } : defaultOptions;
};

export interface IDeferred<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
  promise: Promise<T>;
}

export const getDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};
