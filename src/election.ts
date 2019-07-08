import BigNumber from 'bignumber.js';
import {
  BehaviorSubject,
  combineLatest,
  from,
  fromEvent,
  Observable,
  of,
  throwError,
  TimeoutError,
} from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  filter,
  finalize,
  map,
  mapTo,
  merge,
  scan,
  switchMap,
  take,
  takeUntil,
  takeWhile,
  timeout,
} from 'rxjs/operators';
import {
  EtcdElectionTimeoutError,
  EtcdNoLeaderError,
  EtcdNotLeaderError,
  InvalidOperationError,
} from './errors';
import { Lease } from './lease';
import { Namespace } from './namespace';
import { IKeyValue } from './rpc';
import { isDelete } from './watch';

/**
 * Data exposed while the current election is campaigning.
 */
export interface ICampaignData {
  /**
   * The key where the current election's data is written to.
   */
  leaderKey: string;

  /**
   * Revision of the leader's key.
   */
  leaderRevision: string;

  /**
   * The leader's lease ID.
   */
  leaseId: string;
}

/**
 * Type delimiter for the `Campaign` type.
 */
export const enum CampaignState {
  Idle = 'idle',
  CreatingLease = 'creatingLease',
  CreatingOwnKey = 'creatingKey',
  Follower = 'follower',
  Leader = 'leader',
}

/**
 * State while it's creating its own candidacy key.
 */
export interface ICreatingOwnKeyState {
  state: CampaignState.CreatingOwnKey;
  lease: Lease;
  leaseId: string;
}

/**
 * State while it's checking out the lease.
 */
export interface ICreatingLeaseState {
  state: CampaignState.CreatingLease;
}

/**
 * State while it's not running for election.
 */
export interface IIdleState {
  state: CampaignState.Idle;
}

/**
 * State when it's a follower or leader.
 */
export interface ICandidateState {
  state: CampaignState.Follower | CampaignState.Leader;
  lease: Lease;
  leaseId: string;
  revision: string;
  key: string;
}

/**
 * Possible states of the campaign.
 */
export type Campaign = IIdleState | ICreatingLeaseState | ICreatingOwnKeyState | ICandidateState;

/**
 * Implmentation of etcd election. This allows for coordination between
 * multiple processes or machines. To create an election, you call
 * `.election()` on the Etcd3 client instance with the unique name of the
 * election and the TTL of the leader (if the leader disappears, this is
 * how long it takes to elect a new leader).
 *
 * The leader is allowed to announce a value, passed to `campaign()`. This
 * doesn't have to be unique between instances. The process will never lose its
 * leadership state until it either terminates, you manually call `resign()`,
 * or etcd cannot be contacted. You can change the announced value
 * using `proclaim()`. For a more advanced campaigning API, check out
 * `campaignAdvanced()`.
 *
 * You can use `observe()` to watch changes to the current leader and
 * announced value. `oberver` returns an RxJS which emits the leader's
 * unique key/value, or undefined if there  is no leader. The leader's
 * value contains that which they passed to `campaign()`.
 *
 * Following the original etcd3 implementation of this
 *
 * @see https://github.com/coreos/etcd/blob/master/clientv3/concurrency/election.go
 *
 * @example
 * const election = new Etcd3().election('my-election', 60);
 *
 * election.observe().subscribe(leader => {
 *   console.log(`The leader ID is ${leader.key.toString()}`);
 *   console.log('The leader campaign() value is ${leader.value.toString()}');
 * });
 *
 * await election.campaign('my-announcement-value');
 */
export class Election {
  /**
   * Gets the current campaign data, if we're campaigning to be a leader.
   * Undefined otherwise.
   */
  public get campaignData(): Readonly<ICampaignData> | undefined {
    const value = this.campaignState.getValue();
    if (value.state === CampaignState.Follower || value.state === CampaignState.Leader) {
      return {
        leaderKey: value.key,
        leaderRevision: value.revision,
        leaseId: value.leaseId,
      };
    }

    return undefined;
  }

  /**
   * Gets an observable containing the state of the campaign.
   */
  public get state(): Observable<Campaign> & { getValue(): Campaign } {
    return this.campaignState;
  }

  /**
   * Gets whether the current instance is the elected leader.
   */
  public get isLeader(): boolean {
    return this.campaignState.getValue().state === CampaignState.Leader;
  }
  /**
   * Prefix for the election keys in etcd.
   */
  public static readonly prefix = 'election';

  /**
   * Namespace within the election.
   */
  private readonly namespace: Namespace;

  private campaignState = new BehaviorSubject<Campaign>({ state: CampaignState.Idle });

  /**
   * Observable stream to watch the election. It's a cold observable, so it's
   * not actually kicked into gear until someone's listening to it.
   *
   * Gets all of our existing keys, and then set up a watching on the
   * election prefix. From that watcher, maintain a list of known candidates.
   */
  private observeStream = of(null).pipe(
    switchMap(() =>
      this.parent
        .getAll()
        .prefix(this.getPrefix())
        .sort('Create', 'Ascend')
        .exec(),
    ),
    switchMap(initialPeers =>
      this.parent
        .watch()
        .prefix(this.getPrefix())
        .startRevision(initialPeers.header.revision)
        .observe()
        .pipe(
          scan((kvs, event) => {
            switch (event.event) {
              case 'delete':
                return kvs.filter(prev => !prev.key.equals(event.value.key));
              case 'put':
                // If we see a put, we'll try to replace any existing key
                // we have for that. If we don't see it, we'll append to the
                // end. We don't need to re-sort things, since watch data is
                // delivered in-order and the create revision will always be
                // either (a) greater than all previous ones when being newly
                // created or (b) unchanged when modifying an existing key.
                const nextKvs = [];
                let added = false;
                for (const kv of kvs) {
                  if (!added && kv.key.equals(event.newValue.key)) {
                    added = true;
                    nextKvs.push(event.newValue);
                  } else {
                    nextKvs.push(kv);
                  }
                }

                if (!added) {
                  nextKvs.push(event.newValue);
                }

                return nextKvs;
              default:
                return kvs;
            }
          }, initialPeers.kvs),
          map(kvs => kvs[0]),
          distinctUntilChanged((a, b) => {
            if (!a || !b) {
              return a === b;
            }

            return a.key.equals(b.key) && a.mod_revision === b.mod_revision;
          }),
        ),
    ),
  );

  constructor(
    public readonly parent: Namespace,
    public readonly name: string,
    public readonly ttl: number = 60,
  ) {
    this.namespace = parent.namespace(this.getPrefix());
  }

  /**
   * Like `campaignAdvanced()`, but returns a Promise that resolves once
   * we're the leader. If you need finer-grain control over campaigning,
   * look at that method. It resolves to the `ICandidateState` if we're
   * now the leader, or `undefined` if `resign()` was called.
   *
   * @example
   * const candidate = client.election('test-election', 1);
   *
   * // Campaign until we're the leader, wait forever potentially:
   * await candidate.campaign('candidate1');
   *
   * // Throw an error if we aren't the leader in 5000ms:
   * await candidate.campaign('candidate1', 5000);
   */
  public campaign(value: string, timeoutMs?: number): Promise<ICandidateState | undefined> {
    let stream = this.campaignAdvanced(value).pipe(
      filter((s): s is ICandidateState => s.state === CampaignState.Leader),
      take(1),
    );

    if (timeoutMs) {
      stream = stream.pipe(
        timeout(timeoutMs),
        catchError(err =>
          throwError(
            err instanceof TimeoutError
              ? new EtcdElectionTimeoutError(
                  `The timeout of ${timeoutMs} was reached while campaigning`,
                )
              : err,
          ),
        ),
      );
    }

    return stream.toPromise();
  }

  /**
   * Starts campaigning to be the election leader with the given value. This
   * doesn't have to be unique between instances. It returns an RxJS observable
   * (rather than a promise, for cancellation purposes) that fires with state
   * changes, and completes once we're elected or if `resign()` is called. If
   * you unsubscribe from it before we become a leader, it'll clean up any
   * of its established state.
   *
   * The process will never lose its leadership state until it either
   * terminates, you manually call `resign()`, or etcd cannot be contacted.
   * You can change the announced value using `proclaim()`.
   *
   * @example
   * const candidate = client.election('test-election', 1);
   *
   * // Equivalent of campaign('candidate1'):
   * await candidate.campaignAdvanced('candidate1')
   *   .pipe(filter(state => state.state === 'leader'))
   *    .toPromise();
   *
   * // Using rxjs, you can time out and retry errors
   * await candidate.campaignAdvanced('candidate1')
   *   .pipe(
   *     timeout(1000),
   *     retry(3),
   *     filter(state => state.state === 'leader')
   *   )
   *   .toPromise();
   */
  public campaignAdvanced(value: string): Observable<Campaign> {
    if (this.campaignState.getValue().state !== CampaignState.Idle) {
      throw new InvalidOperationError(
        'Cannot campaign() while already campaigning, use proclaim() to announce a new value',
      );
    }

    this.campaignState.next({ state: CampaignState.CreatingLease });

    const announce = <T extends Campaign>(state: T): T => {
      this.campaignState.next(state);
      return state;
    };

    const election = of(null).pipe(
      switchMap(() => this.getLease()),
      map(lease => announce({ state: CampaignState.CreatingOwnKey, ...lease })),
      switchMap(({ lease, leaseId }) =>
        from(
          this.namespace
            .put(leaseId)
            .value(value)
            .lease(leaseId),
        ).pipe(
          map(result =>
            announce({
              state: CampaignState.Follower,
              lease,
              leaseId,
              key: `${this.getPrefix()}${leaseId}`,
              revision: result.header.revision,
            }),
          ),
          // Once we have our inserted our value, wait to be elected.
          switchMap(state => this.waitForElected(state)),
          // Catch any errors in campaigning and resign if we see them. This
          // comes before the lease lost handler, since if we lost the
          // lease we've already resigned.
          catchError(async err => {
            try {
              await this.resign();
            } catch {
              // ignored
            }

            throw err;
          }),
          // If we lose the lease in this process, bubble that error up. The
          // loss handler attached in getLease() will handle setting the
          // campaign state for us.
          merge(fromEvent(lease, 'lost').pipe(switchMap(err => throwError(err)))),
          // Once we do emit, mark us as a leader:
          map(state => {
            this.campaignState.next(state);
          }),
        ),
      ),
      // If we stop listening to the stream before we
      // become a leader, cleanup.
      finalize(() => {
        const state = this.campaignState.getValue();
        if (state.state !== CampaignState.Leader) {
          this.resign().catch(() => undefined);
        }
      }),
    );

    return this.campaignState.pipe(
      // Emit states until the election fires, which'll be immediately (same
      // call stack) after the campaignState is succeeded.
      takeUntil(election),
      // Stop doing anything if we resign:
      takeWhile(s => s.state !== CampaignState.Idle),
    );
  }

  /**
   * Proclaim lets the leader announce a new value with another election.
   * Throws an `EtcdNotLeaderError` if campaign() has not been called.
   */
  public async proclaim(value: string | Buffer | number) {
    const current = await this.campaignState
      .pipe(
        filter(
          (s): s is ICandidateState | IIdleState =>
            s.state >= CampaignState.Follower || s.state === CampaignState.Idle,
        ),
        take(1),
      )
      .toPromise();

    if (current.state === CampaignState.Idle) {
      throw new EtcdNotLeaderError();
    }

    const r = await this.namespace
      .if(current.leaseId, 'Create', '==', current.revision)
      .then(
        this.namespace
          .put(current.leaseId)
          .value(value)
          .lease(current.leaseId),
      )
      .commit();

    if (!r.succeeded) {
      this.campaignState.next({ state: CampaignState.Idle });
      throw new EtcdNotLeaderError();
    }
  }

  /**
   * Resigns as the cluster leader. This is a no-op if the current instance
   * is not the cluster leader.
   */
  public async resign() {
    const previous = this.campaignState.getValue();
    this.campaignState.next({ state: CampaignState.Idle });
    if (!('lease' in previous)) {
      return;
    }

    await previous.lease.revoke();
  }

  /**
   * Returns the current leader, if any. Throws an `EtcdNoLeaderError` there's
   * no leader.
   */
  public async getLeader() {
    const peers = await this.getPeers();
    if (peers.length === 0) {
      throw new EtcdNoLeaderError();
    }

    return `${this.getPrefix()}${peers[0]}`;
  }

  /**
   * Returns all peers in the cluster. The leader will be listed first.
   */
  public async getPeers() {
    return await this.namespace
      .getAll()
      .sort('Create', 'Ascend')
      .keys();
  }

  /**
   * Returns an rxjs stream of the current key/value of the leader. Emits
   * undefined if there is no current leader.
   */
  public observe(): Observable<IKeyValue | undefined> {
    return this.observeStream;
  }

  private getLease() {
    const lease = this.namespace.lease(this.ttl);
    lease.on('lost', () => {
      this.campaignState.next({ state: CampaignState.Idle });
    });
    return from(lease.grant()).pipe(map(leaseId => ({ leaseId, lease })));
  }

  /**
   * Waits for the current candidate to be elected. Returns an observable that
   * emits once we are.
   */
  private waitForElected(state: ICandidateState): Observable<ICandidateState> {
    // Find last create before this. If there is none, we're the leader.
    // Otherwise, wait for all the previous keys to be deleted

    const lastRevision = new BigNumber(state.revision).minus(1).toString();
    return from(
      this.namespace
        .getAll()
        .maxCreateRevision(lastRevision)
        .exec(),
    ).pipe(
      switchMap(result => {
        if (!result.kvs.length) {
          return of(undefined);
        }

        return combineLatest(
          result.kvs.map(({ key }) =>
            this.namespace
              .watch()
              .key(key)
              .startRevision(result.header.revision)
              .observe()
              .pipe(
                filter(isDelete),
                take(1),
              ),
          ),
        );
      }),
      mapTo({ ...state, state: CampaignState.Leader }),
    );
  }

  private getPrefix() {
    return `${Election.prefix}/${this.name}/`;
  }
}
