
import { Etcd3 } from '../src';
import { createTestClientAndKeys, tearDownTestClient } from './util';

describe('Election', () => {
  let client: Etcd3;

  before(async () => {
    client = await createTestClientAndKeys();
  });
  after(async () => {
    await tearDownTestClient(client);
  });

  it('Elects first client campaigning as leader', () => {
    let election = client.election('test');

    //election
      //.on('following', () => done(new Error('this client should be leading')))
      //.on('leading', () => done());

    console.log('host-0001');
    return election.campaign('host-0001');
  })

  it('Waits until previous leader resigns', () => {
    let election = client.election('test');

    //election
      //.on('following', () => done())
      //.on('leading', () => done(new Error('this client should be following')));
  
    console.log('host-0002');
    return election.campaign('host-0002');
  })
})
