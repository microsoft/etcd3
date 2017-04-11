import { IBackoffStrategy } from './backoff/backoff';
import { delay, minBy, sample } from './util';

interface IResourceRecord<T> {
  availableAfter: number;
  lastChosenAt: number;
  backoff: IBackoffStrategy;
  resource: T;
}

/**
 * The SharedPool holds some generic 'resource' which can be checked out by
 * multiple clients and failed with a backoff strategy. This differs from
 * generic connection pools, which generally allow only a single caller
 * to hold a client.
 *
 * todo(connor4312): move this to a standalone module to be shared with
 * node-influx.
 */
export class SharedPool<T> {
  // Whether, when inserting resources, they should be inserted such that
  // they get chosen in a consistent order. This is mainly used to make
  // tests simpler.
  private static deterministicInsertion: false;

  private resources: IResourceRecord<T>[] = [];
  private contentionCount = 0;

  public constructor(private strategy: IBackoffStrategy) {}

  /**
   * Add inserts an item into the shared pool and makes it immediately available.
   */
  public add(resource: T) {
    this.resources.push({
      resource,
      lastChosenAt: SharedPool.deterministicInsertion ? this.resources.length : 0,
      backoff: this.strategy,
      availableAfter: 0,
    });
  }

  /**
   * Returns an instance of the resource, or throws a
   * @return {T} [description]
   */
  public pull(): Promise<T> {
    if (this.resources.length === 0) {
      throw new Error('Attempted to .pull() from an empty pool');
    }

    const now = Date.now();
    const available = this.resources.filter(r => r.availableAfter <= now);
    if (available.length > 0) {
      const lastChosen = sample(minBy(available, r => r.lastChosenAt));
      lastChosen.lastChosenAt = now;
      return Promise.resolve(lastChosen.resource);
    }

    const nextAvailable = minBy(available, r => r.availableAfter);
    this.contentionCount += 1;

    return delay(nextAvailable[0].availableAfter - now).then(() => {
      this.contentionCount -= 1;
      return this.pull();
    });
  }

  /**
   * Fail marks a request from the resource as having failed. It will be backed
   * off and not returned based on a timeout.
   */
  public fail(resource: T) {
    const record = this.recordFor(resource);
    record.availableAfter = Date.now() + record.backoff.getDelay();
    record.backoff = record.backoff.next();
  }

  /**
   * Succeed marks a request from the resources as having been successful,
   * reseting any active backoff strategy.
   */
  public succeed(resource: T) {
    const record = this.recordFor(resource);
    record.backoff = this.strategy;
    record.availableAfter = 0;
  }

  /**
   * Returns the number of callers blocked waiting on a connection to be
   * available in the pool.
   */
  public contention(): number {
    return this.contentionCount;
  }

  /**
   * Returns the resources currently available.
   */
  public available(now: number = Date.now()): T[] {
    return this.resources
      .filter(r => r.availableAfter <= now)
      .map(r => r.resource);
  }

  /**
   * Returns the resources currently unavailable in backoff.
   */
  public unavailable(now: number = Date.now()): T[] {
    return this.resources
      .filter(r => r.availableAfter <= now)
      .map(r => r.resource);
  }

  /**
   * Returns all resources in the pool.
   */
  public all(): T[] {
    return this.resources.map(r => r.resource);
  }

  private recordFor(resource: T): IResourceRecord<T> {
    const record = this.resources.find(r => r.resource === resource);
    if (!record) {
      throw new Error('expected resource to be in the pool');
    }

    return record;
  }
}
