
import { BigNumber } from 'bignumber.js';
import { EventEmitter } from 'events';

import { Namespace } from './namespace';
import { EtcdElectionNoLeaderError, EtcdElectionNotLeaderError, EtcdElectionCampaignCancelledError } from './errors';
import { IResponseHeader } from './rpc';

export enum CampaignState {
  Pending = 0,
  Campaigning = 1,
  Leading = 2,
  Cancelled = 3,
}

/**
 * Etcd3 based election
 * The largest part is a (mostly) direct port of the GO implementation
 * https://github.com/etcd-io/etcd/blob/master/clientv3/concurrency/election.go
 */
export class Election extends EventEmitter {
  private static readonly prefix: string = 'election';
  private readonly timeout: number;

  private readonly keyPrefix: string;
  private readonly session: Namespace;
  public leaderKey: string;
  public leaderRevision: BigNumber;
  private leaderLeaseId: string | null;
  public header: IResponseHeader;

  constructor(session: Namespace, prefix: string, timeout: number | undefined = 5) {
    super();
    this.keyPrefix = prefix;
    this.session = session;
    this.timeout = timeout;
  }

  private getKey(leaseId: string): string {
    // Format as hexadecimal
    const leaseString = new BigNumber(leaseId).toString(16);
    return `${this.getPrefix()}${leaseString}`;
  }

  private getPrefix(): string {
    return `${Election.prefix}/${this.keyPrefix}/`;
  }

  /**
   * Wait for the deletion of a key
   */
  private waitDelete(key: string, revision: string) {
    console.log(`Waiting for deletion of ${key} at revision ${revision}`);
    return this.session.watch()
      .key(key)
      .startRevision(revision)
      .create()

      .then(watcher => {
        // TODO - Reject after a timeout?
        return new Promise((resolve, reject) => {
          watcher.on('delete', data => {
            console.log('deleted', data);
            return resolve(data);
          });

          this.on('cancelled', () => {
            return reject(new EtcdElectionCampaignCancelledError());
          });
        })
      })
  }

  /**
   * Wait for the deletion of previous keys
   */
  private waitDeletes(maxCreateRevision: BigNumber): Promise<IResponseHeader> {
    return this.session
      .getAll()
      .prefix(this.getPrefix())
      .maxCreateRevision(maxCreateRevision.toString())
      .sort("Create", "Descend")
      .exec()

      .then(res => {
        if(res.kvs.length == 0)
          return res.header;

        // Loop until all keys are gone
        let lastKey = res.kvs[0].key.toString();
        return this.waitDelete(lastKey, res.header.revision)
          .then(() => this.waitDeletes(maxCreateRevision));
      })
  }

  /**
   * Campaign in current election to be leader
   */
  public campaign(value: string) {
    const lease = this.session.lease(this.timeout);
    // TODO - What to do with lost lease?
    //lease.on('lost', () => {
      //console.log('Lost');
    //});

    lease.grant()
      .then(leaseId => {
        let key = this.getKey(leaseId)

        // Create comparing query
        return this.session.if(key, 'Create', '==', 0)
          .then(this.session.put(key).value(value).lease(leaseId))
          .else(this.session.get(key))
          .commit()

          .then(res => {
            this.leaderKey = key;
            this.leaderRevision = new BigNumber(res.header.revision);
            this.leaderLeaseId = leaseId;

            if( ! res.succeeded) {
              // TODO - When does this happen?
              console.log('No succeed');
              console.log(res.responses[0])
            }

            return this.waitDeletes(this.leaderRevision.minus(1))
              .then(() => {
                this.header = res.header;
                this.emit('elected');
              })
          })
      })
  }

  /**
   * Change leaders value without starting new election
   */
  public proclaim(value: string) {
    if( ! this.leaderLeaseId) throw new EtcdElectionNotLeaderError();

    return this.session.if(this.leaderKey, 'Create', '==', this.leaderRevision.toString())
      .then(this.session.put(this.leaderKey).value(value).lease(this.leaderLeaseId))
      .commit()

      .then(res => {
        if( ! res.succeeded) {
          this.leaderKey = "";
          throw new EtcdElectionNotLeaderError();
        }

        this.header = res.header;
      })
  }

  /**
   * Stop being leader
   */
  public resign() {
    // Seems we're not leading anyway
    if(this.leaderLeaseId === null)
      return

    return this.session.if(this.leaderKey, 'Create', '==', this.leaderRevision.toString())
      .then(this.session.delete().key(this.leaderKey))
      .commit()

      .then(res => {
        this.header = res.header;
        this.leaderKey = "";
        this.leaderLeaseId = null;
      })
  }
}


