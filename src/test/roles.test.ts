/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';
import * as grpc from '@grpc/grpc-js';

import {
  Etcd3,
  EtcdAuthenticationFailedError,
  EtcdPermissionDeniedError,
  EtcdRoleExistsError,
  EtcdRoleNotFoundError,
  EtcdRoleNotGrantedError,
  EtcdUserExistsError,
  EtcdUserNotFoundError,
  Role,
} from '..';
import {
  createTestClientAndKeys,
  expectReject,
  getOptions,
  tearDownTestClient,
  setupAuth,
  removeAuth,
} from './util';
import { GRPCDeadlineExceededError } from '../errors';

function wipeAll(things: Promise<Array<{ delete(): any }>>) {
  return things.then(items => Promise.all(items.map(item => item.delete())));
}

describe('roles and auth', () => {
  let client: Etcd3;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => await tearDownTestClient(client));

  describe('management', () => {
    afterEach(() => wipeAll(client.getRoles()));

    const expectRoles = async (expected: string[]) => {
      const list = await client.getRoles();
      expect(list.map(r => r.name)).to.deep.equal(expected);
    };

    it('create and deletes', async () => {
      const fooRole = await client.role('foo').create();
      await expectRoles(['foo']);
      await fooRole.delete();
      await expectRoles([]);
    });

    it('throws on existing roles', async () => {
      await client.role('foo').create();
      await expectReject(client.role('foo').create(), EtcdRoleExistsError);
    });

    it('throws on deleting a non-existent role', async () => {
      await expectReject(client.role('foo').delete(), EtcdRoleNotFoundError);
    });

    it('throws on granting permission to a non-existent role', async () => {
      await expectReject(
        client.role('foo').grant({
          permission: 'Read',
          range: client.range({ prefix: '111' }),
        }),
        EtcdRoleNotFoundError,
      );
    });

    it('round trips permission grants', async () => {
      const fooRole = await client.role('foo').create();
      await fooRole.grant({
        permission: 'Read',
        range: client.range({ prefix: '111' }),
      });

      const perms = await fooRole.permissions();
      expect(perms).to.containSubset([
        {
          permission: 'Read',
          range: client.range({ prefix: '111' }),
        },
      ]);

      await fooRole.revoke(perms);
      expect(await fooRole.permissions()).to.have.length(0);
    });
  });

  describe('users', () => {
    let fooRole: Role;
    beforeEach(async () => {
      fooRole = client.role('foo');
      await fooRole.create();
    });

    afterEach(async () => {
      await fooRole.delete();
      await wipeAll(client.getUsers());
    });

    it('creates users', async () => {
      expect(await client.getUsers()).to.have.lengthOf(0);
      await client.user('connor').create('password');
      expect(await client.getUsers()).to.containSubset([{ name: 'connor' }]);
    });

    it('throws on existing users', async () => {
      await client.user('connor').create('password');
      await expectReject(client.user('connor').create('password'), EtcdUserExistsError);
    });

    it('throws on regranting the same role multiple times', async () => {
      const user = await client.user('connor').create('password');
      await expectReject(user.removeRole(fooRole), EtcdRoleNotGrantedError);
    });

    it('throws on granting a non-existent role', async () => {
      const user = await client.user('connor').create('password');
      await expectReject(user.addRole('wut'), EtcdRoleNotFoundError);
    });

    it('throws on deleting a non-existent user', async () => {
      await expectReject(client.user('connor').delete(), EtcdUserNotFoundError);
    });

    it('round trips roles', async () => {
      const user = await client.user('connor').create('password');
      await user.addRole(fooRole);
      expect(await user.roles()).to.containSubset([{ name: 'foo' }]);
      await user.removeRole(fooRole);
      expect(await user.roles()).to.have.lengthOf(0);
    });
  });

  describe('password auth', () => {
    beforeEach(async () => {
      await setupAuth(client);
    });

    afterEach(async () => {
      await removeAuth(client);
    });

    it('allows authentication using the correct credentials', async () => {
      const authedClient = new Etcd3(
        getOptions({
          auth: {
            username: 'connor',
            password: 'password',
          },
        }),
      );

      await authedClient.put('foo').value('bar');
      authedClient.close();
    });

    it('applies call options', async () => {
      const authedClient = new Etcd3(
        getOptions({
          auth: {
            username: 'connor',
            password: 'password',
            callOptions: { deadline: new Date(0) },
          },
        }),
      );

      await expect(authedClient.put('foo').value('bar')).to.be.rejectedWith(
        GRPCDeadlineExceededError,
      );
      authedClient.close();
    });

    it('rejects modifying a key the client has no access to', async () => {
      const authedClient = new Etcd3(
        getOptions({
          auth: {
            username: 'connor',
            password: 'password',
          },
        }),
      );

      await expectReject(authedClient.put('wut').value('bar').exec(), EtcdPermissionDeniedError);

      authedClient.close();
    });

    it('throws when using incorrect credentials', async () => {
      const authedClient = new Etcd3(
        getOptions({
          auth: {
            username: 'connor',
            password: 'bad password',
          },
        }),
      );

      await expectReject(
        authedClient.put('foo').value('bar').exec(),
        EtcdAuthenticationFailedError,
      );

      authedClient.close();
    });

    it('automatically retrieves a new token if the existing one is invalid', async () => {
      const authedClient = new Etcd3(
        getOptions({
          auth: {
            username: 'connor',
            password: 'password',
          },
        }),
      );
      const auth = (authedClient as any).pool.authenticator;
      const badMeta = new grpc.Metadata();
      badMeta.add('token', 'lol');
      auth.awaitingMetadata = Promise.resolve(badMeta);

      await authedClient.put('foo').value('bar'); // should retry and not throw
      authedClient.close();

      const updatedMeta: grpc.Metadata = await auth.awaitingMetadata;
      expect(updatedMeta.get('token')).to.not.deep.equal(badMeta.get('token'));
    });
  });
});
