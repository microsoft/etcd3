import BigNumber from 'bignumber.js'
import { Lease } from './lease'
import { Namespace } from './namespace'

export class Election {
  public static readonly prefix = 'election'
  public static readonly ttl = 1
  public static readonly notLeaderError = new Error('election: not leader')
  public static readonly noLeaderError = new Error('election: no leader')
  public static readonly notReadyError = new Error('election: no ready')

  public readonly namespace: Namespace
  public readonly lease: Lease

  private _leaseId = ''
  private _leaderKey = ''
  private _leaderRevision = ''
  private _isLeader = false

  get leaseId(): string { return this._leaseId }
  get leaderKey(): string { return this._leaderKey }
  get leaderRevision(): string { return this._leaderRevision }
  get isReady(): boolean { return this._leaseId.length > 0 }
  get isLeader(): boolean { return this._isLeader }

  constructor(namespace: Namespace,
              public readonly name: string) {
    this.namespace = namespace.namespace(this.getPrefix())
    this.lease = this.namespace.lease(Election.ttl)
    this.lease.grant().then(leaseId => this._leaseId = leaseId)
  }

  public async ready() {
    await this.lease.grant()
  }

  public async campaign(value: any) {
    this.throwIfNotReady()
    const result = await this.namespace.if(this.leaseId, 'Create', '==', 0)
                                       .then(this.namespace.put(this.leaseId).value(value).lease(this.leaseId))
                                       .else(this.namespace.get(this.leaseId))
                                       .commit()

    this._leaderKey = `${this.getPrefix()}/${this.leaseId}`
    this._leaderRevision = result.header.revision
    this._isLeader = true

    if (!result.succeeded) {
      try {
        const kv = result.responses[0].response_range.kvs[0]
        this._leaderRevision = kv.create_revision
        await this.proclaim(value)
      } catch (err) {
        await this.resign();
        throw err
      }
    }

    try {
      await this.waitForElected()
    } catch (err) {
      this._isLeader = false
    }
  }

  public async proclaim(value: any) {
    this.throwIfNotReady()

    if (!this._isLeader) {
      throw Election.notLeaderError
    }

    const r = await this.namespace.if(this.leaseId, 'Create', '==', this._leaderRevision)
                                  .then(this.namespace.put(this.leaseId).value(value).lease(this.leaseId))
                                  .commit()

    if (!r.succeeded) {
      this._leaderKey = '';
      throw Election.notLeaderError
    }
  }

  public async resign() {
    this.throwIfNotReady()

    if (!this.isLeader) {
      return
    }

    await this.namespace.if(this.leaseId, 'Create', '==', this._leaderRevision)
                                  .then(this.namespace.delete().key(this.leaseId))
                                  .commit()
    this._leaderKey = ''
    this._leaderRevision = ''
    this._isLeader = false
  }

  public async getLeader() {
    const result = await this.namespace.getAll().sort('Create', 'Ascend').keys()
    if (result.length === 0) {
      return
    }
    return result[0]
  }

  public getPrefix() {
    return `${Election.prefix}/${this.name}/`
  }

  private async waitForElected() {
    // find last create before this
    const lastRevision = new BigNumber(this.leaderRevision).minus(1).toString()
    const result = await this.namespace.getAll().maxCreateRevision(lastRevision).keys()

    // no one before this, elected
    if (result.length === 0) {
      return
    }

    await new Promise(async (resolve, reject) => {
      // waiting for deleting of that key
      const lastKey = result[0]
      const watcher = await this.namespace.watch().key(lastKey).create()
      watcher.on('delete', resolve)
      watcher.on('error', reject)
    })
  }

  private throwIfNotReady(): void {
    if (!this.isReady) {
      throw Election.notReadyError
    }
  }
}
