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
    election = new Election(client, 'test-election');
    await election.ready();
    await election.campaign('candidate');
  });

  afterEach(async () => {
    await election.resign();
    await tearDownTestClient(client);
  });

  describe('campaign', () => {

    it('should wait for elected in campaign', async () => {
      const client2 = new Etcd3(getOptions());
      const election2 = new Election(client2, 'test-election');

      await election2.ready();

      expect(election.isCampaigning).to.be.true;
      expect(election2.isCampaigning).to.be.false;

      const waitElection2 = election2.campaign('election2').then(() => {
        expect(election.isCampaigning).to.be.false;
        expect(election2.isCampaigning).to.be.true;
      });

      await sleep(10);

      await election.resign();

      await waitElection2;

      await tearDownTestClient(client2);
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
      expect(whenCatch.calledWith(Election.notLeaderError)).to.be.true;
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
      expect(whenCatch.calledWith(Election.noLeaderError)).to.be.true;
    });

  });
});
