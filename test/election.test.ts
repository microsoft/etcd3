import { expect } from 'chai';
import * as sinon from 'sinon';

import { BehaviorSubject, Observable } from 'rxjs';
import { filter, first, share, take, takeWhile } from 'rxjs/operators';
import { CampaignState, Election, Etcd3, IKeyValue, InvalidOperationError } from '../src';
import { delay } from '../src/util';
import { createTestClient, getOptions, tearDownTestClient } from './util';

describe('elect()', () => {
  let client: Etcd3;
  let election: Election;

  beforeEach(async () => {
    client = createTestClient();
    election = client.election('test-election', 1);
    await election.campaign('candidate');
  });

  afterEach(async () => {
    await election.resign();
    await tearDownTestClient(client);
  });

  describe('campaign', () => {
    it('should wait for elected in campaign', async () => {
      const client2 = createTestClient();
      const election2 = client2.election('test-election', 1);

      const client3 = createTestClient();
      const election3 = client3.election('test-election', 1);

      /**
       * phase 0: client elected
       * phase 1: client resigned, client2 elected
       * phase 2: client2 resigned, client3 elected
       */
      let phase = 0;

      const waitElection2 = election2
        .campaign('candidate2')
        .then(() => election.getLeader())
        .then(currentLeaderKey => {
          expect(phase).to.equal(1);
          expect(currentLeaderKey).to.equal(election2.campaignData!.leaderKey);
        });

      // essure client2 has joined campaign before client3
      await delay(100);

      const waitElection3 = election3
        .campaign('candidate3')
        .then(() => election.getLeader())
        .then(currentLeaderKey => {
          expect(phase).to.equal(2);
          expect(currentLeaderKey).to.equal(election3.campaignData!.leaderKey);
        });

      // ensure client3 joined campaign
      await delay(100);

      phase = 1;

      await election.resign();

      // ensure client2 and client3 watcher triggered
      await delay(100);

      phase = 2;

      await election2.resign();

      await delay(100);

      await election3.resign();

      await Promise.all([waitElection2, waitElection3]);
    });

    it('should throw if campaign repeatly', async () => {
      expect(election.campaign).to.be.ok;

      const oldValue = await client.get(election.campaignData!.leaderKey);
      expect(oldValue).to.equal('candidate');

      expect(() => election.campaign('new-value')).to.throw(InvalidOperationError);
    });

    describe('interruptions', () => {
      const interruptState = [
        CampaignState.CreatingLease,
        CampaignState.CreatingOwnKey,
        CampaignState.Follower,
      ];

      const ensureClean = async () => {
        await delay(50);
        expect(election.state.getValue().state).to.equal(CampaignState.Idle);
        expect(await client.getAll().keys()).to.be.empty;
      };

      interruptState.forEach(state => {
        it(`unsubscribes when ${state}`, async () => {
          await election.resign();

          await election
            .campaignAdvanced('a')
            .pipe(takeWhile(s => s.state !== state))
            .toPromise();

          await ensureClean();
        });
      });

      interruptState.forEach(state => {
        it(`resigns when ${state}`, async () => {
          await election.resign();

          const resign = new BehaviorSubject(false);
          let completed = false;

          await election
            .campaignAdvanced('a')
            .pipe(takeWhile(s => s.state !== state))
            .subscribe(
              s => {
                if (resign.getValue()) {
                  throw new Error(`expected to stop after resigning, but got ${s.state}`);
                }

                if (s.state === state) {
                  resign.next(true);
                }
              },
              undefined,
              () => (completed = true),
            );

          await resign.pipe(take(1)).toPromise();
          await election.resign();
          expect(completed).to.be.true;
          await ensureClean();
        });
      });
    });
  });

  describe('proclaim', () => {
    it('should update if is a leader', async () => {
      const oldValue = await client.get(election.campaignData!.leaderKey);
      expect(oldValue).to.equal('candidate');
      await election.proclaim('new-candidate');
      const newValue = await client.get(election.campaignData!.leaderKey);
      expect(newValue).to.equal('new-candidate');
    });

    it('should throw if not a leader', async () => {
      await election.resign();
      const whenCatch = sinon.spy();
      await election.proclaim('new-candidate').catch(whenCatch);
      expect(whenCatch.calledOnce).to.be.true;
    });
  });

  describe('getLeader', () => {
    it('should return leader key', async () => {
      const leaderKey = await election.getLeader();
      expect(election.campaignData).to.containSubset({ leaderKey });
    });

    it('should throw if no leader', async () => {
      await election.resign();
      const whenCatch = sinon.spy();
      await election.getLeader().catch(whenCatch);
      expect(whenCatch.calledOnce).to.be.true;
    });
  });

  describe('observe', () => {
    const awaitLeaderValue = (
      observer: Observable<IKeyValue | undefined>,
      leader: string | undefined,
    ) =>
      observer
        .pipe(
          filter(v => (leader ? !!v && v.value.toString() === leader : v === undefined)),
          first(),
        )
        .toPromise();

    it('emits when leaders change', async () => {
      const election2 = new Etcd3(getOptions()).election('test-election', 1);
      const observer = election.observe().pipe(share());
      const subscription = observer.subscribe(); // keep the observable hot

      let leader = awaitLeaderValue(observer, 'candidate');
      await leader;

      const waitElection2 = election2.campaign('candidate2');
      leader = awaitLeaderValue(observer, 'candidate2');
      await election.resign();

      await waitElection2;
      await leader;

      election2.resign();
      await awaitLeaderValue(observer, undefined);

      subscription.unsubscribe();
    });

    it('emits when new values are proclaimed', async () => {
      const observer = election.observe().pipe(share());
      const subscription = observer.subscribe(); // keep the observable hot

      await awaitLeaderValue(observer, 'candidate');

      const newValue = awaitLeaderValue(observer, 'new value!');
      election.proclaim('new value!');
      await newValue;

      subscription.unsubscribe();
    });
  });
});
