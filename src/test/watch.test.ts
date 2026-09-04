/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Etcd3, Watcher } from '../index.js';
import type { IKeyValue, IWatchCreateRequest, IWatchResponse } from '../index.js';
import type { WatchManager } from '../watch.js';
import { NSApplicator, onceEvent } from '../util.js';
import {
  createTestClientAndKeys,
  getOptions,
  proxy,
  tearDownTestClient,
  setupAuth,
  removeAuth,
  isAtLeastVersion,
} from './util.js';
import { EtcdPermissionDeniedError } from '../errors.js';

describe('Watcher.lastRevision()', () => {
  const createWatcher = (request: IWatchCreateRequest = {}) =>
    new Watcher(
      { attach: () => undefined } as unknown as WatchManager,
      NSApplicator.default,
      request,
    );

  it('returns null before connection', () => {
    expect(createWatcher().lastRevision()).toBeNull();
  });

  it('returns a lossless bigint resume revision', () => {
    const revision = '9007199254740993';
    const watcher = createWatcher({ start_revision: revision });

    expect(watcher.lastRevision()).toBe(BigInt(revision));
    expect(typeof watcher.lastRevision()).toBe('bigint');
    expect(watcher.request.start_revision).toBe(revision);
  });
});

describe('watch()', () => {
  let client: Etcd3;

  beforeEach(async () => {
    client = new Etcd3(getOptions());
  });
  afterEach(async () => {
    await tearDownTestClient(client);
  });

  /**
   * Returns the list of watchers currently attached and listening.
   */
  function getWatchers(): Watcher[] {
    return (client as any).watchManager.watchers;
  }

  /**
   * Checks that the watcher is getting updates for the given key.
   */
  function expectWatching(watcher: Watcher, key: string): Promise<Watcher> {
    return Promise.all([
      client.put(key).value('updated!'),
      onceEvent(watcher, 'put').then((res: IKeyValue) => {
        expect(res.key.toString()).toBe(key);
        expect(res.value.toString()).toBe('updated!');
      }),
    ]).then(() => watcher);
  }

  /**
   * Checks that the watcher is not getting updates for the given key.
   */
  async function expectNotWatching(watcher: Watcher, key: string): Promise<Watcher> {
    let watching = false;
    const listener = () => (watching = true);
    watcher.on('put', listener);
    await client.put(key).value('updated!');

    return new Promise<Watcher>(resolve => {
      setTimeout(() => {
        expect(watching, `expected not to be watching ${key}`).toBe(false);
        resolve(watcher);
      }, 200);
    });
  }

  describe('network interruptions', () => {
    it.skip('is resilient to network interruptions', async () => {
      await proxy.activate();
      const proxiedClient = await createTestClientAndKeys();

      const watcher = await proxiedClient.watch().key('foo1').create();
      proxy.suspend();
      await onceEvent(watcher, 'disconnected');
      proxy.unsuspend();
      await onceEvent(watcher, 'connected');
      await expectWatching(watcher, 'foo1');

      await watcher.cancel();
      proxiedClient.close();
      await proxy.deactivate();
    });

    // todo(connor4312): this is disabled pending resolution on:
    // https://github.com/grpc/grpc-node/issues/80
    it.skip('replays historical updates', async () => {
      await proxy.activate();
      const proxiedClient = await createTestClientAndKeys();

      const watcher = await proxiedClient.watch().key('foo1').create();

      await Promise.all([
        client.put('foo1').value('update 1'),
        onceEvent(watcher, 'data').then((res: IWatchResponse) => {
          expect(watcher.request.start_revision).toBe(
            (BigInt(res.header.revision) + 1n).toString(),
          );
        }),
      ]);

      proxy.suspend();
      await onceEvent(watcher, 'disconnected');
      proxy.unsuspend();
      await onceEvent(watcher, 'put').then((res: IKeyValue) => {
        expect(res.key.toString()).toBe('foo1');
        expect(res.value.toString()).toBe('update 2');
      });

      await watcher.cancel();
      proxiedClient.close();
      await proxy.deactivate();
    });

    it('caps watchers revisions', async () => {
      await proxy.activate();
      const proxiedClient = await createTestClientAndKeys();

      const watcher = await proxiedClient.watch().key('foo1').create();
      proxy.suspend();
      await onceEvent(watcher, 'disconnected');
      const actualRevision = Number(watcher.request.start_revision);
      watcher.request.start_revision = 999999;
      proxy.unsuspend();
      await onceEvent(watcher, 'connected');
      expect(Number(watcher.request.start_revision)).toBe(actualRevision);

      await watcher.cancel();
      proxiedClient.close();
      await proxy.deactivate();
    });

    describe('emits an error if a watcher is cancelled upon creation (#114)', () => {
      beforeEach(async () => await setupAuth(client));
      afterEach(async () => await removeAuth(client));

      if (isAtLeastVersion('3.2.0')) {
        it('is fixed', async () => {
          const authedClient = new Etcd3(
            getOptions({
              auth: {
                username: 'connor',
                password: 'password',
              },
            }),
          );

          await expect(authedClient.watch().key('outside of range').create()).rejects.toThrow(
            EtcdPermissionDeniedError,
          );
        });
      }
    });
  });

  describe('subscription', () => {
    it('subscribes before the connection is established', async () => {
      const watcher = await client.watch().key('foo1').create();
      await expectWatching(watcher, 'foo1');
      expect(getWatchers()).toEqual([watcher]);
      await watcher.cancel();
    });

    it('subscribes while the connection is still being established', async () => {
      const watcher1 = client.watch().key('foo1').create();
      const watcher2 = client.watch().key('bar').create();

      const watchers = await Promise.all([
        watcher1.then(w => expectWatching(w, 'foo1')),
        watcher2.then(w => expectWatching(w, 'bar')),
      ]);

      expect(getWatchers()).toEqual(watchers);
      await (await watcher1).cancel();
      await (await watcher2).cancel();
    });

    it('subscribes in series', async () => {
      const watcher1 = client.watch().key('foo1').watcher();
      const watcher2 = client.watch().key('bar').watcher();
      const events: string[] = [];

      watcher1.on('connecting', () => events.push('connecting1'));
      watcher1.on('connected', () => events.push('connected1'));
      watcher2.on('connecting', () => events.push('connecting2'));
      watcher2.on('connected', () => events.push('connected2'));

      await onceEvent(watcher2, 'connected');

      expect(events).toEqual(['connecting1', 'connected1', 'connecting2', 'connected2']);
      await watcher1.cancel();
      await watcher2.cancel();
    });

    it('subscribes after the connection is fully established', async () => {
      const watcher1 = await client.watch().key('foo1').create();
      await expectWatching(watcher1, 'foo1');
      const watcher2 = await client.watch().key('bar').create();
      await expectWatching(watcher2, 'bar');
      expect(getWatchers()).toEqual([watcher1, watcher2]);
      await watcher1.cancel();
      await watcher2.cancel();
    });

    it('allows successive resubscription (issue #51)', async () => {
      const watcher1 = await client.watch().key('foo1').create();
      await expectWatching(watcher1, 'foo1');
      await watcher1.cancel();

      const watcher2 = await client.watch().key('foo1').create();
      await expectWatching(watcher2, 'foo1');
      await watcher2.cancel();
    });
  });

  describe('unsubscribing', () => {
    it('unsubscribes while the connection is established', async () => {
      const watcher = await client.watch().key('foo1').create();
      await watcher.cancel();
      await expectNotWatching(watcher, 'foo1');
      expect(getWatchers()).toEqual([]);
    });

    it('unsubscribes while the connection is being reestablished', async () => {
      await proxy.activate();
      const proxiedClient = await createTestClientAndKeys();

      const watcher = await proxiedClient.watch().key('foo1').create();
      proxy.suspend();
      await watcher.cancel();

      proxy.unsuspend();
      expect(getWatchers()).toEqual([]);

      proxiedClient.close();

      // todo: this should be awaited, but when the client is closed the tcp
      // end will time out (after 2 minutes). We can implement a client graceful
      // close once https://github.com/grpc/grpc-node/issues/1340
      proxy.deactivate();
    });
  });
});
