/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as grpc from '@grpc/grpc-js';

import {
  AuthClient,
  Etcd3,
  EtcdAuthenticationFailedError,
  EtcdPermissionDeniedError,
  EtcdRoleExistsError,
  EtcdRoleNotFoundError,
  EtcdRoleNotGrantedError,
  EtcdUserExistsError,
  EtcdUserNotFoundError,
  Role,
} from '../index.js';
import type { ICallable, Services } from '../rpc.js';
import {
  createTestClientAndKeys,
  expectReject,
  getOptions,
  tearDownTestClient,
  setupAuth,
  removeAuth,
} from './util.js';
import { GRPCDeadlineExceededError } from '../errors.js';

function wipeAll(things: Promise<Array<{ delete(): any }>>) {
  return things.then(items => Promise.all(items.map(item => item.delete())));
}

interface IAuthCall {
  method: string;
  params: unknown;
  options: grpc.CallOptions | undefined;
}

function createRoleWithFakeClient() {
  const calls: IAuthCall[] = [];
  const callable: ICallable<unknown> = {
    callOptionsFactory: undefined,
    exec<T>(
      _service: keyof typeof Services,
      method: string,
      params: unknown,
      options?: grpc.CallOptions,
    ): Promise<T> {
      void _service;
      calls.push({ method, params, options });
      return Promise.resolve({} as T);
    },
    withConnection<R>(
      _service: keyof typeof Services,
      _fn: (args: {
        resource: unknown;
        client: grpc.Client;
        metadata: grpc.Metadata;
      }) => Promise<R> | R,
    ): Promise<R> {
      void _service;
      void _fn;
      return Promise.reject(new Error('Unexpected streaming request'));
    },
    markFailed(_resource: unknown, _error: Error): void {
      void _resource;
      void _error;
    },
  };

  return { calls, role: new Role(new AuthClient(callable), 'test-role') };
}

describe('roles and auth', () => {
  let client: Etcd3;

  beforeEach(async () => (client = await createTestClientAndKeys()));
  afterEach(async () => await tearDownTestClient(client));

  describe('management', () => {
    afterEach(() => wipeAll(client.getRoles()));

    const expectRoles = async (expected: string[]) => {
      const list = await client.getRoles();
      expect(list.map(r => r.name)).toEqual(expected);
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
      expect(perms).toMatchObject([
        {
          permission: 'Read',
          range: client.range({ prefix: '111' }),
        },
      ]);

      await fooRole.revoke(perms[0]);
      expect(await fooRole.permissions()).toHaveLength(0);
    });
  });

  describe('role permission RPC forwarding', () => {
    const readKey = { permission: 'Read' as const, key: 'read-key' };
    const writeKey = { permission: 'Write' as const, key: 'write-key' };

    it('revokes every permission when revoking an array', async () => {
      const { calls, role } = createRoleWithFakeClient();

      await role.revoke([readKey, writeKey]);

      expect(calls.map(call => call.method)).toEqual([
        'roleRevokePermission',
        'roleRevokePermission',
      ]);
    });

    it('forwards call options when revoking one permission', async () => {
      const { calls, role } = createRoleWithFakeClient();
      const options: grpc.CallOptions = { deadline: new Date(0) };

      await role.revoke(readKey, options);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: 'roleRevokePermission',
        params: {
          role: 'test-role',
          key: Buffer.from('read-key'),
          range_end: Buffer.alloc(0),
        },
      });
      expect(calls[0].options).toBe(options);
    });

    it('forwards call options for every permission in a grant array', async () => {
      const { calls, role } = createRoleWithFakeClient();
      const options: grpc.CallOptions = { deadline: new Date(0) };

      await role.grant([readKey, writeKey], options);

      expect(calls.map(call => call.method)).toEqual([
        'roleGrantPermission',
        'roleGrantPermission',
      ]);
      expect(calls.map(call => call.options)).toEqual([options, options]);
      expect(calls.map(call => call.options).every(option => option === options)).toBe(true);
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
      expect(await client.getUsers()).toHaveLength(0);
      await client.user('connor').create('password');
      expect(await client.getUsers()).toMatchObject([{ name: 'connor' }]);
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
      expect(await user.roles()).toMatchObject([{ name: 'foo' }]);
      await user.removeRole(fooRole);
      expect(await user.roles()).toHaveLength(0);
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

      await expect(authedClient.put('foo').value('bar')).rejects.toThrow(GRPCDeadlineExceededError);
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
      const pool = (authedClient as any).pool;
      const auth = pool.authenticator;
      const host = pool.hosts[0];
      const badMeta = new grpc.Metadata();
      badMeta.add('token', 'lol');
      auth.awaitingMetadata.set(host.address, Promise.resolve(badMeta));

      await authedClient.put('foo').value('bar'); // should retry and not throw
      const updatedMeta: grpc.Metadata = await auth.getMetadata(host.address);
      expect(updatedMeta.get('token')).not.toEqual(badMeta.get('token'));
      authedClient.close();
    });
  });
});
