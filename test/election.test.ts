import { expect } from 'chai';
import * as sinon from 'sinon';

import { Election,
         Etcd3 } from '../src';
import { getOptions,
         tearDownTestClient } from './util';

const sleep = (t: number) =>  new Promise(resolve => setTimeout(resolve, t));

describe('election', () => {
  let client: Etcd3;
  let election: Election;

  beforeEach(async () => {
    client = new Etcd3(getOptions());
    election = new Election(client, 'test-election', 1);
    await election.ready();
    await election.campaign('candidate');
  });

  afterEach(async () => {
    election.removeAllListeners();
    await election.resign();
    await tearDownTestClient(client);
  });

  describe('campaign', () => {

    it('should wait for elected in campaign', async () => {
      const client2 = new Etcd3(getOptions());
      const election2 = new Election(client2, 'test-election', 1);

      const client3 = new Etcd3(getOptions());
      const election3 = new Election(client3, 'test-election', 1);

      /**
       * phase 0: client elected
       * phase 1: client resigned, client2 elected
       * phase 2: client2 resigned, client3 elected
       */
      let phase = 0;

      const waitElection2 = election2.campaign('candidate2')
        .then(() => election.getLeader())
        .then(currentLeaderKey => {
          expect(phase).to.equal(1);
          expect(currentLeaderKey).to.equal(election2.leaderKey);
        });

      // essure client2 has joined campaign before client3
      await sleep(100);

      const waitElection3 = election3.campaign('candidate3')
        .then(() => election.getLeader())
        .then(currentLeaderKey => {
          expect(phase).to.equal(2);
          expect(currentLeaderKey).to.equal(election3.leaderKey);
        });

      // ensure client3 joined campaign
      await sleep(100);

      phase = 1;

      await election.resign();

      // ensure client2 and client3 watcher triggered
      await sleep(100);

      phase = 2;

      await election2.resign();

      await sleep(100);

      await election3.resign();

      await Promise.all([waitElection2, waitElection3]);
    });

    it('should proclaim if campaign repeatly', async () => {
      expect(election.isCampaigning).to.be.true;

      const oldValue = await client.get(election.leaderKey);
      expect(oldValue).to.equal('candidate');

      await election.campaign('new-value');
      const newValue = await client.get(election.leaderKey);
      expect(newValue).to.equal('new-value');
    });

    it('only proclaim if value changed', async () => {
      const proclaimFn = sinon
        .stub(election, 'proclaim')
        .callsFake(Election.prototype.proclaim.bind(election));

      await election.campaign('candidate');
      expect(proclaimFn.notCalled).to.be.true;
      await election.campaign('candidate2');
      expect(proclaimFn.calledOnce).to.be.true;

      proclaimFn.restore();
    });

  });

  describe('proclaim', () => {

    it('should update if is a leader', async () => {
      const oldValue = await client.get(election.leaderKey);
      expect(oldValue).to.equal('candidate');
      await election.proclaim('new-candidate');
      const newValue = await client.get(election.leaderKey);
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
      expect(election.leaderKey).to.equal(leaderKey);
    });

    it('should throw if no leader', async () => {
      await election.resign();
      const whenCatch = sinon.spy();
      await election.getLeader().catch(whenCatch);
      expect(whenCatch.calledOnce).to.be.true;
    });

  });

  describe('observe', () => {
    it('should emit leader event', async () => {
      const client2 = new Etcd3(getOptions());
      const election2 = new Election(client2, 'test-election', 1);

      let currentLeaderKey = '';
      election.on('leader', leaderKey => currentLeaderKey = leaderKey);

      expect(election.isObserving).to.be.true;

      // looking for current leader and emit it
      await sleep(30);

      expect(currentLeaderKey).to.equal(election.leaderKey);

      const waitElection2 = election2.campaign('candidate2');

      await election.resign();

      await waitElection2;

      // waiting for watcher
      await sleep(30);

      expect(currentLeaderKey).to.equal(election2.leaderKey);
    });

    it('should wait for leader', async () => {
      await election.resign();

      let currentLeaderKey = '';
      election.on('leader', leaderKey => currentLeaderKey = leaderKey);

      // waiting for watcher created
      await sleep(30);

      await election.campaign('candidate');

      await sleep(30);

      expect(currentLeaderKey).to.equal(election.leaderKey);
    });
  });
});
