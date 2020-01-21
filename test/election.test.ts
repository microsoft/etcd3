
import { expect } from 'chai';

import { Etcd3 } from '../src';
import { Election } from '../src/election';
import { createTestClientAndKeys, tearDownTestClient } from './util';
import { delay } from '../src/util';

describe('Election', () => {
  let client: Etcd3;

  beforeEach(async () => {
    client = await createTestClientAndKeys();
  });
  afterEach(() => tearDownTestClient(client));

  it('Elects first client campaigning as leader', async () => {
    let election0 = client.election('test', 1);
    let election1 = client.election('test', 1);

    election0.campaign('0')
    // Give election0 some time to become leader
    await delay(25);
    election1.campaign('1')

    expect(election0.leader()).to.eventually.equal('0')
    expect(election1.leader()).to.eventually.equal('0')
  })

  it('Takes over leadership on leader resignation', async () => {
    let election0 = client.election('test', 1);
    let election1 = client.election('test', 1);

    election0.campaign('0');
    // Give election0 some time to become leader
    await delay(25);
    election1.campaign('1');
    await delay(25);
    election0.resign();
    await delay(25);

    expect(election0.leader()).to.eventually.equal('1')
    expect(election1.leader()).to.eventually.equal('1')
  })
    /*

  it('Takes over leadership when leader fails', async () => {
    let election0 = client.election('test', 1);
    let election1 = client.election('test', 1);

    election0.campaign('0');
    // Give election0 some time to become leader
    await delay(25);
    election1.campaign('1');
    await delay(25);

    expect(election1.leader()).to.eventually.equal('1')
  })
     */
})
