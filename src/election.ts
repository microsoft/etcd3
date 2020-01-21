
import { BigNumber } from 'bignumber.js';
import { Lease } from './lease';

import { IKeyValue } from './rpc';
import { Namespace } from './namespace';
import { EtcdElectionNoLeaderError, EtcdElectionNotLeaderError } from './errors';

/**
 * Etcd3 based election
 * For most part a port of the GO implementation
 * https://github.com/etcd-io/etcd/blob/master/clientv3/concurrency/election.go
 */
export class Election {
  private static readonly prefix: string = 'election';

  public leaderKey: string;
  public leaderRevision: BigNumber;

  private readonly keyPrefix: string;
  private readonly client: Namespace;
  private lease: Lease;

  constructor(client: Namespace, prefix: string, timeout: number | undefined = 5) {
    this.keyPrefix = prefix;
    this.client = client;
    this.lease = client.lease(timeout);
  }

  /**
   * Campaign in current election to be leader
   */
  public campaign(value: string) {
    // TODO - Does losing lease have repercussions?

    // Get the leaseID specifically to append it to key
    return this.lease.grant()
      .then(leaseId => {
        const key = this.getKey(leaseId)

        // Create comparing query
        return this.client.if(key, 'Create', '==', 0)
          .then(this.client.put(key).value(value).lease(leaseId))
          .else(this.client.get(key))
          .commit()

          .then(res => {
            this.leaderKey = key;
            this.leaderRevision = new BigNumber(res.header.revision);

            if( ! res.succeeded) {
              // TODO - When does this happen?
              // TODO - How do i test this?
              const kv = res.responses[0].response_range.kvs[0];
              this.leaderRevision = new BigNumber(kv.create_revision);

              if(kv.value.toString() !== value) {
                return this.proclaim(value)
                  .catch(err => {
                    return this.resign()
                      .then(() => { throw err });
                  });
              }
            }

            return;
          })
      })
  }

  /**
   * Change leaders value without starting new election
   */
  public proclaim(value: string) {
    if( ! this.leaderKey) {
      throw new EtcdElectionNotLeaderError();
    }

    return this.client.if(this.leaderKey, 'Create', '==', this.leaderRevision.toString())
      .then(this.client.put(this.leaderKey).value(value).lease(this.lease.grant()))
      .commit()

      .then(res => {
        if( ! res.succeeded) {
          this.leaderKey = "";
          throw new EtcdElectionNotLeaderError();
        }
      })
  }

  /**
   * Stop being leader
   */
  public resign() {
    // Seems we're not leading anyway
    if( ! this.leaderKey) {
      return Promise.resolve();
    }


    return this.client.if(this.leaderKey, 'Create', '==', this.leaderRevision.toString())
      .then(this.client.delete().key(this.leaderKey))
      .commit()

      .then(() => {
        this.leaderKey = "";
        // Delete lease so we can create a new one
        delete this.lease;
      })
  }

  /**
   * Get the current leader
   */
  public leader(): Promise<IKeyValue> {
    return this.client
      .getAll()
      .prefix(this.getPrefix())
      .sort("Create", "Ascend")
      .exec()

      .then(res => {
        if(res.kvs.length === 0) {
          throw new EtcdElectionNoLeaderError();
        }

        return res.kvs[0];
      })
  }

  public if_leading(): Promise<IKeyValue> {
    return this.leader()
      .then(kv => {
        if(kv.create_revision !== this.leaderRevision.toString() || kv.key.toString() !== this.leaderKey) {
          throw new EtcdElectionNotLeaderError();
        }

        return kv;
      })
  }

  /**
   * Kill this elections lease (used in tests to simulate leader being killed)
   */
  public kill() {
    return this.lease.revoke();
  }

  private getKey(leaseId: string): string {
    // Format as hexadecimal
    const leaseString = new BigNumber(leaseId).toString(16);
    return `${this.getPrefix()}${leaseString}`;
  }

  private getPrefix(): string {
    return `${Election.prefix}/${this.keyPrefix}/`;
  }
}


