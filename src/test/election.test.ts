import { expect } from 'chai';
import { fromEvent } from 'rxjs';
import { take } from 'rxjs/operators';
import { Election, Etcd3 } from '../';
import { Campaign } from '../election';
import { NotCampaigningError } from '../errors';
import { delay, getDeferred, onceEvent } from '../util';
import { getOptions, tearDownTestClient } from './util';

const sleep = (t: number) => new Promise(resolve => setTimeout(resolve, t));

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

      /**
       * phase 0: client elected
       * phase 1: client resigned, client2 elected
       * phase 2: client2 resigned, client3 elected
       */
      let phase = 0;

      const campaign2 = election2.campaign('candidate2');
      const phase1Defer = getDeferred<void>();
      const waitElection2 = campaign2
        .wait()
        .then(() => election.leader())
        .then(leader => {
          expect(phase).to.equal(1);
          expect(leader).to.equal('candidate2');
          phase1Defer.resolve();
        });

      // essure client2 has joined campaign before client3
      await sleep(100);

      const campaign3 = election3.campaign('candidate3');
      const phase2Defer = getDeferred<void>();
      const waitElection3 = campaign3
        .wait()
        .then(() => election.leader())
        .then(leader => {
          expect(phase).to.equal(2);
          expect(leader).to.equal('candidate3');
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
    });

    it('should proclaim initial value', async () => {
      const key = await campaign.getCampaignKey();
      const oldValue = await client.get(key);
      expect(oldValue).to.equal('candidate');
    });
  });

  describe('proclaim', () => {
    it('should update if campaign', async () => {
      const key = await campaign.getCampaignKey();
      const oldValue = await client.get(key);
      expect(oldValue).to.equal('candidate');

      await campaign.proclaim('new-candidate');
      const newValue = await client.get(key);
      expect(newValue).to.equal('new-candidate');
    });

    it('should not update if resigned', async () => {
      await campaign.resign();
      await expect(campaign.proclaim('new-candidate')).to.eventually.be.rejectedWith(
        NotCampaigningError,
      );
    });

    it('should not update key was tampered with', async () => {
      await client.delete().key(await campaign.getCampaignKey());
      await expect(campaign.proclaim('new-candidate')).to.eventually.be.rejectedWith(
        NotCampaigningError,
      );
    });

    it('should proclaim changes during initial publish', async () => {
      await campaign.resign();

      campaign = election.campaign('old-value');
      const key = await campaign.getCampaignKey(); // wait until initial is running

      await campaign.proclaim('new-value');
      expect(await client.get(key).string()).to.equal('new-value');
    });
  });

  describe('getLeader', () => {
    it('should return leader value', async () => {
      expect(await election.leader()).to.equal('candidate');
    });

    it('return undefined no leader', async () => {
      await campaign.resign();
      expect(await election.leader()).to.be.undefined;
    });
  });

  describe('observe', () => {
    it('emits when existing leader resigns and other in queue', async () => {
      const client2 = new Etcd3(getOptions());
      const election2 = new Election(client2, 'test-election', 1);

      const observer = await election.observe();
      const changeEvent = fromEvent(observer, 'change');

      expect(observer.leader()).to.equal('candidate');

      const campaign2 = election2.campaign('candidate2');
      while ((await client2.getAll().prefix('election').keys()).length < 2) {
        await delay(5);
      }

      const [newLeader] = await Promise.all([
        changeEvent.pipe(take(1)).toPromise(),
        campaign.resign(),
      ]);

      expect(newLeader).to.equal('candidate2');
      await observer.cancel();
      await campaign2.resign();
    });

    it('emits when leader steps down', async () => {
      const observer = await election.observe();
      expect(observer.leader()).to.equal('candidate');

      const changeEvent = fromEvent(observer, 'change');
      const [newLeader] = await Promise.all([
        changeEvent.pipe(take(1)).toPromise(),
        campaign.resign(),
      ]);

      expect(newLeader).to.be.undefined;
    });

    it('emits when leader is newly elected', async () => {
      await campaign.resign();

      const observer = await election.observe();
      const changeEvent = fromEvent(observer, 'change');

      expect(observer.leader()).to.be.undefined;

      const campaign2 = election.campaign('candidate');
      const [, newLeader] = await Promise.all([
        campaign2.wait(),
        changeEvent.pipe(take(1)).toPromise(),
      ]);

      expect(newLeader).to.equal('candidate');
      await campaign2.resign();
      await observer.cancel();
    });
  });

  it('fixes #176', async function () {
    const observer1 = await election.observe();

    const client2 = new Etcd3(getOptions());
    const election2 = client2.election('test-election', 1);
    const observer2 = await election2.observe();
    const campaign2 = election2.campaign('candidate2');
    await onceEvent(campaign2, '_isWaiting');

    const client3 = new Etcd3(getOptions());
    const election3 = client3.election('test-election', 1);
    const observer3 = await election3.observe();
    const campaign3 = election3.campaign('candidate3');
    await onceEvent(campaign3, '_isWaiting');

    expect(observer1.leader()).to.equal('candidate');
    expect(observer2.leader()).to.equal('candidate');
    expect(observer3.leader()).to.equal('candidate');

    const changes: string[] = [];
    campaign.on('elected', () => changes.push('leader is now 1'));
    campaign3.on('elected', () => changes.push('leader is now 3'));

    await campaign2.resign();
    await delay(1000); // give others a chance to see the change, if any

    expect(observer1.leader()).to.equal('candidate');
    expect(observer3.leader()).to.equal('candidate');
    expect(changes).to.be.empty;

    client2.close();
    client3.close();
  });
});
