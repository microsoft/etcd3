import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Election, Etcd3 } from '../index.js';
import { Campaign, ElectionObserver } from '../election.js';
import { NotCampaigningError } from '../errors.js';
import { delay, getDeferred, onceEvent } from '../util.js';
import { getOptions, tearDownTestClient } from './util.js';

const sleep = (t: number) => new Promise(resolve => setTimeout(resolve, t));

async function cleanUpElectionResources(
  observers: Array<ElectionObserver | undefined>,
  campaigns: Array<Campaign | undefined>,
  clients: Array<Etcd3 | undefined>,
) {
  const activeObservers = observers.filter(
    (observer): observer is ElectionObserver => observer !== undefined,
  );
  const activeCampaigns = campaigns.filter(
    (campaign): campaign is Campaign => campaign !== undefined,
  );
  const activeClients = clients.filter((client): client is Etcd3 => client !== undefined);

  try {
    await Promise.all(activeObservers.map(observer => observer.cancel()));
    await delay(0);
  } finally {
    try {
      await Promise.all(activeCampaigns.map(campaign => campaign.resign()));
    } finally {
      activeClients.forEach(client => client.close());
    }
  }
}

function campaignNamespace(result: object): ConstructorParameters<typeof Campaign>[0] {
  return {
    lease: () => ({
      grant: async () => 'campaign-key',
      on: () => undefined,
      revoke: async () => undefined,
    }),
    put: () => ({
      value: () => ({
        lease: () => undefined,
      }),
    }),
    get: () => undefined,
    if: () => ({
      then: () => ({
        else: () => ({
          commit: async () => result,
        }),
      }),
    }),
  } as unknown as ConstructorParameters<typeof Campaign>[0];
}

function campaignNamespaceWith(
  lease: EventEmitter,
  commit: () => Promise<object>,
): ConstructorParameters<typeof Campaign>[0] {
  return {
    lease: () => lease,
    put: () => ({
      value: () => ({
        lease: () => undefined,
      }),
    }),
    get: () => undefined,
    if: () => ({
      then: () => ({
        else: () => ({
          commit,
        }),
      }),
    }),
  } as unknown as ConstructorParameters<typeof Campaign>[0];
}

const campaignInternals = Campaign.prototype as unknown as {
  waitForElected(revision: string): Promise<void>;
};

describe('election', () => {
  let client: Etcd3;
  let election: Election;
  let campaign: Campaign;

  beforeEach(async () => {
    client = new Etcd3(getOptions());
    election = new Election(client, 'test-election', 1);
    campaign = await election.campaign('candidate').wait();
  });

  afterEach(async () => {
    await campaign.resign();
    await tearDownTestClient(client);
    client.close();
  });

  describe('campaign', () => {
    it('should wait for elected in campaign', async () => {
      const client2 = new Etcd3(getOptions());
      const election2 = new Election(client2, 'test-election', 1);
      const client3 = new Etcd3(getOptions());
      const election3 = new Election(client3, 'test-election', 1);
      const campaign2 = election2.campaign('candidate2');
      let campaign3: Campaign | undefined;

      try {
        /**
         * phase 0: client elected
         * phase 1: client resigned, client2 elected
         * phase 2: client2 resigned, client3 elected
         */
        let phase = 0;

        const phase1Defer = getDeferred<void>();
        const waitElection2 = campaign2
          .wait()
          .then(() => election.leader())
          .then(leader => {
            expect(phase).toBe(1);
            expect(leader).toBe('candidate2');
            phase1Defer.resolve();
          });

        // essure client2 has joined campaign before client3
        await sleep(100);

        campaign3 = election3.campaign('candidate3');
        const phase2Defer = getDeferred<void>();
        const waitElection3 = campaign3
          .wait()
          .then(() => election.leader())
          .then(leader => {
            expect(phase).toBe(2);
            expect(leader).toBe('candidate3');
            phase2Defer.resolve();
          });

        // ensure client3 joined campaign
        await sleep(100);

        phase = 1;
        await campaign.resign();
        await phase1Defer.promise;

        phase = 2;
        await campaign2.resign();
        await phase2Defer.promise;

        await campaign3.resign();
        await Promise.all([waitElection2, waitElection3]);
      } finally {
        await cleanUpElectionResources([], [campaign2, campaign3], [client2, client3]);
      }
    });

    it('should proclaim initial value', async () => {
      const key = await campaign.getCampaignKey();
      const oldValue = await client.get(key);
      expect(oldValue).toBe('candidate');
    });

    it('does not elect a queued campaign that resigns before its predecessor', async () => {
      const predecessorDeleted = getDeferred<void>();
      const waiting = getDeferred<void>();
      const waitForElected = vi
        .spyOn(campaignInternals, 'waitForElected')
        .mockImplementation(() => {
          waiting.resolve();
          return predecessorDeleted.promise;
        });

      try {
        const queuedCampaign = new Campaign(
          campaignNamespace({ succeeded: true, header: { revision: '10' }, responses: [] }),
          'candidate2',
          1,
        );
        const elected = vi.fn();
        queuedCampaign.on('elected', elected);

        await waiting.promise;
        await queuedCampaign.resign();
        predecessorDeleted.resolve();
        await Promise.resolve();

        expect(elected).not.toHaveBeenCalled();
      } finally {
        waitForElected.mockRestore();
      }
    });

    it('waits using the existing campaign key create revision after a transaction retry', async () => {
      const waitedRevision = getDeferred<string>();
      const waitForElected = vi
        .spyOn(campaignInternals, 'waitForElected')
        .mockImplementation(revision => {
          waitedRevision.resolve(revision);
          return Promise.resolve();
        });

      try {
        new Campaign(
          campaignNamespace({
            succeeded: false,
            header: { revision: '10' },
            responses: [
              {
                response_range: {
                  kvs: [{ create_revision: '5', value: Buffer.from('candidate2') }],
                },
              },
            ],
          }),
          'candidate2',
          1,
        );

        await expect(waitedRevision.promise).resolves.toBe('5');
      } finally {
        waitForElected.mockRestore();
      }
    });

    it('makes lease loss terminal and settles waiting operations', async () => {
      const initialCommitStarted = getDeferred<void>();
      const initialCommit = getDeferred<object>();
      const lease = Object.assign(new EventEmitter(), {
        grant: vi.fn(async () => 'campaign-key'),
        revoke: vi.fn(async () => undefined),
      });
      const campaign = new Campaign(
        campaignNamespaceWith(lease, async () => {
          initialCommitStarted.resolve();
          return initialCommit.promise;
        }),
        'candidate2',
        1,
      );
      const elected = vi.fn();
      const errors = vi.fn();
      campaign.on('elected', elected);
      campaign.on('error', errors);

      await initialCommitStarted.promise;
      const waiting = campaign.wait();
      const proclamation = campaign.proclaim('new-candidate');
      const loss = new Error('lease lost');

      lease.emit('lost', loss);
      lease.emit('lost', loss);

      await expect(waiting).rejects.toBe(loss);
      await expect(proclamation).rejects.toBe(loss);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalledWith(loss);

      initialCommit.resolve({ succeeded: true, header: { revision: '10' }, responses: [] });
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(elected).not.toHaveBeenCalled();
    });
  });

  describe('proclaim', () => {
    it('should update if campaign', async () => {
      const key = await campaign.getCampaignKey();
      const oldValue = await client.get(key);
      expect(oldValue).toBe('candidate');

      await campaign.proclaim('new-candidate');
      const newValue = await client.get(key);
      expect(newValue).toBe('new-candidate');
    });

    it('should not update if resigned', async () => {
      await campaign.resign();
      await expect(campaign.proclaim('new-candidate')).rejects.toThrow(NotCampaigningError);
    });

    it('should not update key was tampered with', async () => {
      await client.delete().key(await campaign.getCampaignKey());
      await expect(campaign.proclaim('new-candidate')).rejects.toThrow(NotCampaigningError);
    });

    it('should proclaim changes during initial publish', async () => {
      await campaign.resign();

      campaign = election.campaign('old-value');
      const key = await campaign.getCampaignKey(); // wait until initial is running

      await campaign.proclaim('new-value');
      expect(await client.get(key).string()).toBe('new-value');
    });

    it('rejects a pre-publication proclamation when resign wins the race', async () => {
      const initialCommitStarted = getDeferred<void>();
      const initialCommit = getDeferred<object>();
      const lease = Object.assign(new EventEmitter(), {
        grant: vi.fn(async () => 'campaign-key'),
        revoke: vi.fn(async () => undefined),
      });
      const campaign = new Campaign(
        campaignNamespaceWith(lease, async () => {
          initialCommitStarted.resolve();
          return initialCommit.promise;
        }),
        'candidate2',
        1,
      );

      await initialCommitStarted.promise;
      const proclamation = campaign.proclaim('new-candidate');
      await campaign.resign();
      initialCommit.resolve({ succeeded: true, header: { revision: '10' }, responses: [] });

      await expect(proclamation).rejects.toThrow(NotCampaigningError);
    });
  });

  describe('getLeader', () => {
    it('should return leader value', async () => {
      expect(await election.leader()).toBe('candidate');
    });

    it('return undefined no leader', async () => {
      await campaign.resign();
      expect(await election.leader()).toBeUndefined();
    });
  });

  describe('observe', () => {
    it('forwards watcher disconnects while retaining normal cancellation', async () => {
      const emptyWatcher = Object.assign(new EventEmitter(), {
        cancel: vi.fn(async () => undefined),
      });
      const leaderWatcher = Object.assign(new EventEmitter(), {
        cancel: vi.fn(async () => undefined),
      });
      const watchers = [emptyWatcher, leaderWatcher];
      const watchBuilder = {
        startRevision: () => watchBuilder,
        prefix: () => watchBuilder,
        only: () => watchBuilder,
        key: () => watchBuilder,
        watcher: () => watchers.shift(),
      };
      const namespace = {
        getAll: () => ({
          sort: () => ({
            limit: () => ({
              exec: async () => ({ kvs: [], header: { revision: '7' } }),
            }),
          }),
        }),
        watch: () => watchBuilder,
      };
      const observer = new ElectionObserver(
        namespace as unknown as ConstructorParameters<typeof ElectionObserver>[0],
      );
      const disconnected = vi.fn();
      observer.on('disconnected', disconnected);

      await vi.waitFor(() => expect(emptyWatcher.listenerCount('disconnected')).toBe(1));
      const emptyPhaseError = new Error('empty phase disconnected');
      emptyWatcher.emit('disconnected', emptyPhaseError);
      expect(disconnected).toHaveBeenLastCalledWith(emptyPhaseError);

      emptyWatcher.emit('data', {
        events: [
          {
            type: 'Put',
            kv: {
              key: Buffer.from('campaign-key'),
              value: Buffer.from('candidate2'),
              mod_revision: '8',
            },
          },
        ],
      });
      await vi.waitFor(() => expect(leaderWatcher.listenerCount('disconnected')).toBe(1));
      const leaderPhaseError = new Error('leader phase disconnected');
      leaderWatcher.emit('disconnected', leaderPhaseError);

      expect(disconnected).toHaveBeenCalledTimes(2);
      expect(disconnected).toHaveBeenLastCalledWith(leaderPhaseError);
      await observer.cancel();
      expect(emptyWatcher.cancel).toHaveBeenCalled();
      expect(leaderWatcher.cancel).toHaveBeenCalled();
    });

    it('emits when existing leader resigns and other in queue', async () => {
      const client2 = new Etcd3(getOptions());
      const election2 = new Election(client2, 'test-election', 1);
      const observer = await election.observe();
      const campaign2 = election2.campaign('candidate2');

      try {
        expect(observer.leader()).toBe('candidate');

        while ((await client2.getAll().prefix('election').keys()).length < 2) {
          await delay(5);
        }

        const [newLeader] = await Promise.all([onceEvent(observer, 'change'), campaign.resign()]);

        expect(newLeader).toBe('candidate2');
      } finally {
        await cleanUpElectionResources([observer], [campaign2], [client2]);
      }
    });

    it('emits when leader steps down', async () => {
      const observer = await election.observe();

      try {
        expect(observer.leader()).toBe('candidate');

        const [newLeader] = await Promise.all([onceEvent(observer, 'change'), campaign.resign()]);

        expect(newLeader).toBeUndefined();
      } finally {
        await cleanUpElectionResources([observer], [], []);
      }
    });

    it('emits when leader is newly elected', async () => {
      await campaign.resign();

      const observer = await election.observe();
      const campaign2 = election.campaign('candidate');

      try {
        expect(observer.leader()).toBeUndefined();

        const [, newLeader] = await Promise.all([campaign2.wait(), onceEvent(observer, 'change')]);

        expect(newLeader).toBe('candidate');
      } finally {
        await cleanUpElectionResources([observer], [campaign2], []);
      }
    });
  });

  it('fixes #176', async function () {
    let observer1: ElectionObserver | undefined;
    let observer2: ElectionObserver | undefined;
    let observer3: ElectionObserver | undefined;
    let campaign2: Campaign | undefined;
    let campaign3: Campaign | undefined;
    let client2: Etcd3 | undefined;
    let client3: Etcd3 | undefined;

    try {
      observer1 = await election.observe();

      client2 = new Etcd3(getOptions());
      const election2 = client2.election('test-election', 1);
      observer2 = await election2.observe();
      campaign2 = election2.campaign('candidate2');
      await onceEvent(campaign2, '_isWaiting');

      client3 = new Etcd3(getOptions());
      const election3 = client3.election('test-election', 1);
      observer3 = await election3.observe();
      campaign3 = election3.campaign('candidate3');
      await onceEvent(campaign3, '_isWaiting');

      expect(observer1.leader()).toBe('candidate');
      expect(observer2.leader()).toBe('candidate');
      expect(observer3.leader()).toBe('candidate');

      const changes: string[] = [];
      campaign.on('elected', () => changes.push('leader is now 1'));
      campaign3.on('elected', () => changes.push('leader is now 3'));

      await campaign2.resign();
      await delay(1000); // give others a chance to see the change, if any

      expect(observer1.leader()).toBe('candidate');
      expect(observer3.leader()).toBe('candidate');
      expect(changes).toHaveLength(0);
    } finally {
      await cleanUpElectionResources(
        [observer1, observer2, observer3],
        [campaign2, campaign3],
        [client2, client3],
      );
    }
  });
});
