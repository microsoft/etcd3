/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import BigNumber from 'bignumber.js';
import { EventEmitter } from 'events';
import { ClientRuntimeError, EtcdNotLeaderError } from './errors';
import { Lease, LeaseState } from './lease';
import { Namespace } from './namespace';
import { IKeyValue } from './rpc';

export interface Election {
  // tslint:disable-line interface-name
  /**
   * fired after leader elected
   */
  on(event: 'leader', listener: (leaderKey: string) => void): this;
  /**
   * errors are fired when:
   * - observe error
   * - recreate lease fail after lease lost
   */
  on(event: 'error', listener: (error: any) => void): this;
  on(event: string | symbol, listener: Function): this;
}

const UnsetCurrent = Symbol('unset');

/**
 * Object returned from election.observer() that exposees information about
 * the current election.
 */
export class ElectionObserver extends EventEmitter {
  /**
   * Gets whether the election has any leader.
   */
  public get hasLeader() {
    return !!this.current;
  }

  private running = true;
  private runLoop: Promise<void>;
  private disposer?: () => void;
  private current: IKeyValue | typeof UnsetCurrent | undefined = UnsetCurrent;

  constructor(private readonly namespace: Namespace) {
    super();
    this.runLoop = this.loop().catch(err => {
      this.emit('error', err);
    });
  }

  /**
   * change is fired when the elected value changes. It can be fired with
   * undefined if there's no longer a leader.
   */
  public on(event: 'change', handler: (value: string | undefined) => void): this;

  /**
   * error is fired if the underlying election watcher experiences an error.
   */
  public on(event: 'error', handler: (value: string | undefined) => void): this;

  /**
   * Implements EventEmitter.on(...).
   */
  public on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  /**
   * Closes the election observer.
   */
  public async cancel() {
    this.running = false;
    this.disposer?.();
    await this.runLoop;
  }

  /**
   * Returns the currently-elected leader value (passed to `campaign()` or
   * `proclaim()`), or undefined if there's no elected leader.
   */
  public leader(encoding?: BufferEncoding): string | undefined;

  /**
   * Returns the currently-elected leader value (passed to `campaign()` or
   * `proclaim()`), or undefined if there's no elected leader.
   */
  public leader(encoding: 'buffer'): Buffer | undefined;
  public leader(encoding: BufferEncoding | 'buffer' = 'utf-8') {
    const leader = this.current;
    if (!leader || leader === UnsetCurrent) {
      return undefined;
    }

    return encoding === 'buffer' ? leader.value : leader.value.toString(encoding);
  }

  private setLeader(kv: IKeyValue | undefined) {
    const prev = this.current;
    this.current = kv;
    if (prev === UnsetCurrent) {
      this.emit('change', undefined);
    } else if (kv === undefined) {
      if (prev !== undefined) {
        this.emit('change', undefined);
      }
    } else if (!prev || !kv.value.equals(prev.value)) {
      this.emit('change', kv.value.toString());
    }
  }

  private async loop() {
    // @see https://github.com/etcd-io/etcd/blob/28d1af294e4394df1ed967a4ac4fbaf437be3463/client/v3/concurrency/election.go#L177
    while (this.running) {
      const allKeys = await this.namespace.getAll().sort('Create', 'Ascend').limit(1).exec();
      let leader: IKeyValue | undefined = allKeys.kvs[0];
      let revision = allKeys.header.revision;

      if (!this.running) {
        return; // if closed when doing async work
      }

      if (!leader) {
        this.setLeader(undefined);

        const watcher = this.namespace
          .watch()
          .startRevision(allKeys.header.revision)
          .prefix('')
          .ignore('put')
          .watcher();

        await new Promise<void>((resolve, reject) => {
          watcher.on('data', data => {
            let done = false;
            for (const event of data.events) {
              if (event.type === 'Put') {
                leader = event.kv;
                revision = event.kv.mod_revision;
                done = true;
              }
            }
            if (done) {
              resolve();
            }
          });
          watcher.on('error', reject);
          this.disposer = resolve;
        }).finally(() => watcher.cancel());

        if (!this.running) {
          return; // if closed when doing async work
        }
      }

      if (!leader) {
        throw new ClientRuntimeError('unreachable lack of election leader');
      }

      this.setLeader(leader);

      const watcher = this.namespace
        .watch()
        .startRevision(new BigNumber(revision).plus(1).toString())
        .key(leader.key)
        .watcher();

      await new Promise<void>((resolve, reject) => {
        watcher!.on('put', kv => this.setLeader(kv));
        watcher!.on('delete', () => resolve());
        watcher!.on('error', reject);
        this.disposer = () => {
          resolve();
          return watcher.cancel();
        };
      }).finally(() => watcher.cancel());
    }
  }
}

/**
 * Implmentation of etcd election.
 * @see https://github.com/coreos/etcd/blob/master/clientv3/concurrency/election.go
 *
 * @example
 * const client = new Etcd3()
 * const election = new Election(client, 'singleton_service')
 * const id = BigNumber.random().toString()
 *
 * // process will hang here until elected
 * await election.campaign(id)
 */
export class Election extends EventEmitter {
  /**
   * Prefix used in the namespace for election-based operations.
   */
  public static readonly prefix = 'election';

  private readonly namespace: Namespace;
  private lease?: Lease;

  private _leaderKey = '';
  private _leaderRevision = '';
  private _isCampaigning = false;

  public get leaderKey(): string {
    return this._leaderKey;
  }
  public get leaderRevision(): string {
    return this._leaderRevision;
  }
  public get isReady(): boolean {
    return this.lease?.state === LeaseState.Alive;
  }
  public get isCampaigning(): boolean {
    return this._isCampaigning;
  }

  constructor(
    public readonly parent: Namespace,
    public readonly name: string,
    public readonly ttl: number = 60,
  ) {
    super();
    this.namespace = parent.namespace(this.getPrefix());
  }

  /**
   * Puts the value as eligible for election. Multiple sessions can participate
   * in the election for the same prefix, but only one can be the leader at a
   * time.
   *
   * A common pattern in cluster-based applications is to campaign the hostname
   * or IP of the current server, and allow the leader server to be elected
   * among them.
   *
   * This will block until the node is elected.
   */
  public async campaign(value: string) {
    const leaseId = await this.acquireLease();
    const result = await this.namespace
      .if(leaseId, 'Create', '==', 0)
      .then(this.namespace.put(leaseId).value(value).lease(leaseId))
      .else(this.namespace.get(leaseId))
      .commit();

    this._leaderKey = `${this.getPrefix()}${leaseId}`;
    this._leaderRevision = result.header.revision;
    this._isCampaigning = true;

    if (!result.succeeded) {
      try {
        const kv = result.responses[0].response_range.kvs[0];
        this._leaderRevision = kv.create_revision;
        if (kv.value.toString() !== value) {
          await this.proclaim(value);
        }
      } catch (error) {
        await this.resign();
        throw error;
      }
    }

    try {
      await this.waitForElected();
    } catch (error) {
      await this.resign();
      throw error;
    }
  }

  public async proclaim(value: any) {
    if (!this._isCampaigning) {
      throw new EtcdNotLeaderError();
    }

    const leaseId = await this.lease!.grant();
    const r = await this.namespace
      .if(leaseId, 'Create', '==', this._leaderRevision)
      .then(this.namespace.put(leaseId).value(value).lease(leaseId))
      .commit();

    if (!r.succeeded) {
      this._leaderKey = '';
      throw new EtcdNotLeaderError();
    }
  }

  public async resign() {
    if (!this.isCampaigning) {
      return;
    }

    const leaseId = await this.lease!.grant();
    const r = await this.namespace
      .if(leaseId, 'Create', '==', this._leaderRevision)
      .then(this.namespace.delete().key(leaseId))
      .commit();

    if (!r.succeeded) {
      if (!this.lease) {
        return;
      }
      // If fail, revoke lease for performing resigning
      await this.lease.revoke();
      this.lease = this.namespace.lease(this.ttl);
      this.lease.on('lost', err => this.onLeaseLost(err));
    }

    this._leaderKey = '';
    this._leaderRevision = '';
    this._isCampaigning = false;
  }

  /**
   * Returns the currently-elected leader value (passed to `campaign()` or
   * `proclaim()`), or undefined if there's no elected leader.
   */
  public async leader(encoding?: BufferEncoding): Promise<string | undefined>;

  /**
   * Returns the currently-elected leader value (passed to `campaign()` or
   * `proclaim()`), or undefined if there's no elected leader.
   */
  public async leader(encoding: 'buffer'): Promise<Buffer | undefined>;
  public async leader(encoding: BufferEncoding | 'buffer' = 'utf-8') {
    const result = await this.namespace.getAll().sort('Create', 'Ascend').limit(1).exec();
    const leader = result.kvs[0];
    if (leader === undefined) {
      return undefined;
    }

    return encoding === 'buffer' ? leader.value : leader.value.toString();
  }

  public getPrefix() {
    return `${Election.prefix}/${this.name}/`;
  }

  /**
   * Creates the lease for a campaign, if it does not exist, and returns the
   * lease ID once available.
   */
  private acquireLease() {
    if (!this.lease) {
      this.lease = this.namespace.lease(this.ttl);
      this.lease.on('lost', err => this.onLeaseLost(err));
    }

    return this.lease.grant();
  }

  private async waitForElected() {
    // find last create before this
    const lastRevision = new BigNumber(this.leaderRevision).minus(1).toString();
    const result = await this.namespace
      .getAll()
      .maxCreateRevision(lastRevision)
      .sort('Create', 'Descend')
      .exec();

    // no one before this, elected
    if (result.kvs.length === 0) {
      return;
    }

    // wait all keys created ealier are deleted
    await waitForDeletes(
      this.namespace,
      result.kvs.map(k => k.key),
      result.header.revision,
    );
  }

  /**
   * Creates an observer for the election, which emits events when results
   * change. The observer must be closed using `observer.cancel()` when
   * you're finished with it.
   */
  public async observe() {
    const observer = new ElectionObserver(this.namespace);
    return new Promise<ElectionObserver>((resolve, reject) => {
      observer.once('change', () => resolve(observer));
      observer.once('error', reject);
    });
  }

  private onLeaseLost(error: Error) {
    if (this.lease) {
      this.lease.removeAllListeners();
      this.lease = undefined;
    }

    this.emit('error', error);
  }
}

async function waitForDelete(namespace: Namespace, key: Buffer, rev: string) {
  const watcher = await namespace.watch().key(key).startRevision(rev).create();
  const deleteOrError = new Promise((resolve, reject) => {
    // waiting for deleting of that key
    watcher.once('delete', resolve);
    watcher.once('error', reject);
  });

  try {
    await deleteOrError;
  } finally {
    await watcher.cancel();
  }
}

async function waitForDeletes(namespace: Namespace, keys: Buffer[], rev: string) {
  if (keys.length === 0) {
    return;
  }

  if (keys.length === 1) {
    return waitForDelete(namespace, keys[0], rev);
  }

  const tasks = keys.map(key => async () => {
    const keyExisted = (await namespace.get(key).string()) !== null;
    if (!keyExisted) {
      return;
    }
    await waitForDelete(namespace, key, rev);
  });

  let task = tasks.shift();

  while (task) {
    await task();
    task = tasks.shift();
  }
}
