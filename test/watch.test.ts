import BigNumber from 'bignumber.js';
import { expect } from 'chai';

import { Etcd3, IKeyValue, IWatchResponse, Watcher } from '../src';
import { onceEvent } from '../src/util';
import { createTestClientAndKeys, getOptions, proxy, tearDownTestClient } from './util';

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
    return (<any>client).watchManager.watchers;
  }

  /**
   * Checks that the watcher is getting updates for the given key.
   */
  function expectWatching(watcher: Watcher, key: string): Promise<Watcher> {
    return Promise.all([
      client.put(key).value('updated!'),
      onceEvent(watcher, 'put').then((res: IKeyValue) => {
        expect(res.key.toString()).to.equal(key);
        expect(res.value.toString()).to.equal('updated!');
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
        expect(watching).to.equal(false, `expected not to be watching ${key}`);
        resolve(watcher);
      }, 200);
    });
  }

  describe('network interruptions', () => {
    it.skip('is resilient to network interruptions', async () => {
      await proxy.activate();
      const proxiedClient = await createTestClientAndKeys();

      const watcher = await proxiedClient
        .watch()
        .key('foo1')
        .create();

      proxy.pause();
      await onceEvent(watcher, 'disconnected');
      proxy.resume();
      await onceEvent(watcher, 'connected');
      await expectWatching(watcher, 'foo1');

      proxiedClient.close();
      proxy.deactivate();
    });

    // todo(connor4312): this is disabled pending resolution on:
    // https://github.com/grpc/grpc-node/issues/80
    it.skip('replays historical updates', async () => {
      await proxy.activate();
      const proxiedClient = await createTestClientAndKeys();

      const watcher = await proxiedClient
        .watch()
        .key('foo1')
        .create();

      await Promise.all([
        client.put('foo1').value('update 1'),
        onceEvent(watcher, 'data').then((res: IWatchResponse) => {
          expect(watcher.request.start_revision).to.equal(
            new BigNumber(res.header.revision).add(1).toString(),
          );
        }),
      ]);

      proxy.pause();
      await onceEvent(watcher, 'disconnected');
      proxy.resume();
      await onceEvent(watcher, 'put').then((res: IKeyValue) => {
        expect(res.key.toString()).to.equal('foo1');
        expect(res.value.toString()).to.equal('update 2');
      });

      proxiedClient.close();
      proxy.deactivate();
    });

    it('caps watchers revisions', async () => {
      await proxy.activate();
      const proxiedClient = await createTestClientAndKeys();

      const watcher = await proxiedClient
        .watch()
        .key('foo1')
        .create();
      proxy.pause();
      await onceEvent(watcher, 'disconnected');
      const actualRevision = Number(watcher.request.start_revision);
      watcher.request.start_revision = 999999;
      proxy.resume();
      await onceEvent(watcher, 'connected');
      expect(Number(watcher.request.start_revision)).to.equal(actualRevision);
    });
  });

  describe('subscription', () => {
    it('subscribes before the connection is established', async () => {
      const watcher = await client
        .watch()
        .key('foo1')
        .create();
      await expectWatching(watcher, 'foo1');
      expect(getWatchers()).to.deep.equal([watcher]);
    });

    it('subscribes while the connection is still being established', async () => {
      const watcher1 = client
        .watch()
        .key('foo1')
        .create();
      const watcher2 = client
        .watch()
        .key('bar')
        .create();

      const watchers = await Promise.all([
        watcher1.then(w => expectWatching(w, 'foo1')),
        watcher2.then(w => expectWatching(w, 'bar')),
      ]);

      expect(getWatchers()).to.deep.equal(watchers);
    });

    it('subscribes in series', async () => {
      const watcher1 = client
        .watch()
        .key('foo1')
        .watcher();
      const watcher2 = client
        .watch()
        .key('bar')
        .watcher();
      const events: string[] = [];

      watcher1.on('connecting', () => events.push('connecting1'));
      watcher1.on('connected', () => events.push('connected1'));
      watcher2.on('connecting', () => events.push('connecting2'));
      watcher2.on('connected', () => events.push('connected2'));

      await onceEvent(watcher2, 'connected');

      expect(events).to.deep.equal(['connecting1', 'connected1', 'connecting2', 'connected2']);
    });

    it('subscribes after the connection is fully established', async () => {
      const watcher1 = await client
        .watch()
        .key('foo1')
        .create();
      await expectWatching(watcher1, 'foo1');
      const watcher2 = await client
        .watch()
        .key('bar')
        .create();
      await expectWatching(watcher2, 'bar');
      expect(getWatchers()).to.deep.equal([watcher1, watcher2]);
    });

    it('allows successive resubscription (issue #51)', async () => {
      const watcher1 = await client
        .watch()
        .key('foo1')
        .create();
      await expectWatching(watcher1, 'foo1');
      await watcher1.cancel();

      const watcher2 = await client
        .watch()
        .key('foo1')
        .create();
      await expectWatching(watcher2, 'foo1');
      await watcher2.cancel();
    });
  });

  describe('unsubscribing', () => {
    it('unsubscribes while the connection is established', async () => {
      const watcher = await client
        .watch()
        .key('foo1')
        .create();
      await watcher.cancel();
      await expectNotWatching(watcher, 'foo1');
      expect(getWatchers()).to.deep.equal([]);
    });

    it('unsubscribes while the connection is being reestablished', async () => {
      await proxy.activate();
      const proxiedClient = await createTestClientAndKeys();

      const watcher = await proxiedClient
        .watch()
        .key('foo1')
        .create();
      proxy.pause();
      await watcher.cancel();

      proxy.resume();
      expect(getWatchers()).to.deep.equal([]);

      proxiedClient.close();
      proxy.deactivate();
    });
  });
});
