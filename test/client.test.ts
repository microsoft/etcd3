import { expect } from 'chai';
import * as sinon from 'sinon';

import { Etcd3 } from '../src';
import { createTestClientAndKeys, tearDownTestClient } from './util';

describe('client', () => {
  let client: Etcd3;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => await tearDownTestClient(client));

  it('allows mocking', async () => {
    const mock = client.mock({
      exec: sinon.stub(),
      getConnection: sinon.stub(),
    });

    mock.exec.resolves({ kvs: [] });
    expect(await client.get('foo1').string()).to.be.null;
    expect(mock.exec.calledWith('KV', 'range')).to.be.true;
    client.unmock();
    expect(await client.get('foo1').string()).to.equal('bar1');
  });
});
