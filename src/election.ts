import BigNumber from 'bignumber.js';
import { Lease } from './lease';
import { Namespace } from './namespace';

/**
 * Implmentation of etcd election.
 * @see https://github.com/coreos/etcd/blob/master/clientv3/concurrency/election.go
 *
 * @example
 * const client = new Etcd3()
 * const election = new Election(client, 'singleton_service')
 * const id = BigNumber.random().toString()
 *
 * // waiting for election ready
 * await election.ready()
 *
 * // process will hang here until elected
 * await election.campaign(id)
 */
export class Election {
  public static readonly prefix = 'election';
  public static readonly notLeaderError = new Error('election: not leader');
  public static readonly noLeaderError = new Error('election: no leader');
  public static readonly notReadyError = new Error('election: no ready');

  public readonly namespace: Namespace;
  public readonly lease: Lease;

  private _leaseId = '';
  private _leaderKey = '';
  private _leaderRevision = '';
  private _isLeader = false;

  public get leaseId(): string { return this._leaseId; }
  public get leaderKey(): string { return this._leaderKey; }
  public get leaderRevision(): string { return this._leaderRevision; }
  public get isReady(): boolean { return this._leaseId.length > 0; }
  public get isLeader(): boolean { return this._isLeader; }

  constructor(namespace: Namespace,
              public readonly name: string,
              public readonly ttl: number = 60) {
    this.namespace = namespace.namespace(this.getPrefix());
    this.lease = this.namespace.lease(ttl);
  }

  public async ready() {
    const leaseId = await this.lease.grant();

    if (!this.isReady) {
      this._leaseId = leaseId;
    }
  }

  public async campaign(value: any) {
    this.throwIfNotReady();
    const result = await this.namespace
      .if(this.leaseId, 'Create', '==', 0)
      .then(this.namespace.put(this.leaseId).value(value).lease(this.leaseId))
      .else(this.namespace.get(this.leaseId))
      .commit();

    this._leaderKey = `${this.getPrefix()}${this.leaseId}`;
    this._leaderRevision = result.header.revision;
    this._isLeader = true;

    if (!result.succeeded) {
      try {
        const kv = result.responses[0].response_range.kvs[0];
        this._leaderRevision = kv.create_revision;
        await this.proclaim(value);
      } catch (error) {
        await this.resign();
        throw error;
      }
    }

    try {
      await this.waitForElected();
    } catch (error) {
      this._isLeader = false;
      throw error;
    }
  }

  public async proclaim(value: any) {
    this.throwIfNotReady();

    if (!this._isLeader) {
      throw Election.notLeaderError;
    }

    const r = await this.namespace
      .if(this.leaseId, 'Create', '==', this._leaderRevision)
      .then(this.namespace.put(this.leaseId).value(value).lease(this.leaseId))
      .commit();

    if (!r.succeeded) {
      this._leaderKey = '';
      throw Election.notLeaderError;
    }
  }

  public async resign() {
    this.throwIfNotReady();

    if (!this.isLeader) {
      return;
    }

    await this.namespace
      .if(this.leaseId, 'Create', '==', this._leaderRevision)
      .then(this.namespace.delete().key(this.leaseId))
      .commit();

    this._leaderKey = '';
    this._leaderRevision = '';
    this._isLeader = false;
  }

  public async getLeader() {
    const result = await this.namespace.getAll().sort('Create', 'Ascend').keys();
    if (result.length === 0) {
      throw Election.noLeaderError;
    }
    return `${this.getPrefix()}${result[0]}`;
  }

  public getPrefix() {
    return `${Election.prefix}/${this.name}/`;
  }

  private async waitForElected() {
    // find last create before this
    const lastRevision = new BigNumber(this.leaderRevision).minus(1).toString();
    const result = await this.namespace.getAll().maxCreateRevision(lastRevision).keys();

    // no one before this, elected
    if (result.length === 0) {
      return;
    }

    const lastKey = result[0];
    const watcher = await this.namespace.watch().key(lastKey).create();
    const deleteOrError = new Promise(async (resolve, reject) => {
      // waiting for deleting of that key
      watcher.on('delete', resolve);
      watcher.on('error', reject);
    });

    try {
      await deleteOrError;
    } catch (error) {
      throw error;
    } finally {
      await watcher.cancel();
    }
  }

  private throwIfNotReady(): void {
    if (!this.isReady) {
      throw Election.notReadyError;
    }
  }
}
