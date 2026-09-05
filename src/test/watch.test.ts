/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Etcd3, Watcher } from '../index.js';
import type { IKeyValue, IWatchCreateRequest, IWatchResponse } from '../index.js';
import * as RPC from '../rpc.js';
import { WatchManager } from '../watch.js';
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
import { ClientRuntimeError, EtcdPermissionDeniedError } from '../errors.js';

class FakeWatchStream {
  public readonly writes: RPC.IWatchRequest[] = [];
  public cancelCount = 0;
  private dataHandler: ((response: RPC.IWatchResponse) => void) | undefined;
  private errorHandler: ((error: Error) => void) | undefined;

  public write(request: RPC.IWatchRequest) {
    this.writes.push(request);
  }

  public end() {}

  public cancel() {
    this.cancelCount++;
  }

  public on(
    event: 'data' | 'error' | 'end' | 'status',
    handler:
      | ((response: RPC.IWatchResponse) => void)
      | ((error: Error) => void)
      | (() => void)
      | ((status: never) => void),
  ): this {
    if (event === 'data') {
      this.dataHandler = handler as (response: RPC.IWatchResponse) => void;
    } else if (event === 'error') {
      this.errorHandler = handler as (error: Error) => void;
    }
    return this;
  }

  public async *[Symbol.asyncIterator](): AsyncIterableIterator<RPC.IWatchResponse> {}

  public emitData(response: RPC.IWatchResponse) {
    this.dataHandler?.(response);
  }

  public emitError(error: Error) {
    this.errorHandler?.(error);
  }
}

function watchResponse(overrides: Partial<RPC.IWatchResponse> = {}): RPC.IWatchResponse {
  return {
    header: {
      cluster_id: '1',
      member_id: '1',
      revision: '10',
      raft_term: '1',
    },
    watch_id: '1',
    created: false,
    canceled: false,
    compact_revision: '0',
    cancel_reason: '',
    fragment: false,
    events: [],
    ...overrides,
  };
}

async function createFakeWatchManager() {
  const stream = new FakeWatchStream();
  const backoff = {
    duration: 0,
    next: () => backoff,
  };
  const manager = new WatchManager(
    {
      watch: () =>
        Promise.resolve(
          stream as unknown as RPC.IDuplexStream<RPC.IWatchRequest, RPC.IWatchResponse>,
        ),
    } as unknown as RPC.WatchClient,
    { next: () => backoff } as any,
  );
  return { manager, stream };
}

async function waitForFirstWatchRequest(stream: FakeWatchStream) {
  await vi.waitFor(() => expect(stream.writes).toHaveLength(1));
}

describe('WatchManager protocol handling', () => {
  it('does not advance past a fragmented revision until its final response', async () => {
    const { manager, stream } = await createFakeWatchManager();
    const watcher = new Watcher(manager, NSApplicator.default, {});
    await waitForFirstWatchRequest(stream);

    stream.emitData(watchResponse({ created: true, watch_id: '1' }));
    stream.emitData(
      watchResponse({ header: { ...watchResponse().header, revision: '20' }, fragment: true }),
    );

    expect(watcher.lastRevision()).toBe(20n);
    expect(watcher.request.start_revision).toBe('20');

    stream.emitData(watchResponse({ header: { ...watchResponse().header, revision: '20' } }));

    expect(watcher.lastRevision()).toBe(21n);
  });

  it('preserves a replay revision when its create response has a newer header', async () => {
    const { manager, stream } = await createFakeWatchManager();
    const watcher = new Watcher(manager, NSApplicator.default, { start_revision: '5' });
    await waitForFirstWatchRequest(stream);

    stream.emitData(
      watchResponse({
        created: true,
        watch_id: '1',
        header: { ...watchResponse().header, revision: '20' },
      }),
    );

    expect(watcher.lastRevision()).toBe(5n);
    expect(watcher.request.start_revision).toBe('5');

    stream.emitData(
      watchResponse({ header: { ...watchResponse().header, revision: '5' }, fragment: true }),
    );
    expect(watcher.lastRevision()).toBe(5n);

    stream.emitData(watchResponse({ header: { ...watchResponse().header, revision: '5' } }));
    expect(watcher.lastRevision()).toBe(6n);
  });

  it('makes terminal cancellation idempotent and ignores stale responses without disrupting siblings', async () => {
    const { manager, stream } = await createFakeWatchManager();
    const normallyCanceled = new Watcher(manager, NSApplicator.default, {});
    const unexpectedlyCanceled = new Watcher(manager, NSApplicator.default, {});
    const sibling = new Watcher(manager, NSApplicator.default, {});
    const errors: Error[] = [];
    const siblingData = vi.fn();
    unexpectedlyCanceled.on('error', error => errors.push(error));
    sibling.on('data', siblingData);
    await waitForFirstWatchRequest(stream);

    stream.emitData(watchResponse({ created: true, watch_id: '1' }));
    stream.emitData(watchResponse({ created: true, watch_id: '2' }));
    stream.emitData(watchResponse({ created: true, watch_id: '3' }));

    const normalCancel = normallyCanceled.cancel();
    const duplicateNormalCancel = normallyCanceled.cancel();
    expect(stream.writes).toHaveLength(4);
    stream.emitData(watchResponse({ canceled: true, watch_id: '1' }));
    await expect(Promise.all([normalCancel, duplicateNormalCancel])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(normallyCanceled.cancel()).resolves.toBeUndefined();
    expect(stream.writes).toHaveLength(4);

    stream.emitData(
      watchResponse({ canceled: true, watch_id: '2', cancel_reason: 'server canceled' }),
    );
    expect(errors).toHaveLength(1);
    await expect(unexpectedlyCanceled.cancel()).resolves.toBeUndefined();
    expect(stream.writes).toHaveLength(4);

    expect(() => stream.emitData(watchResponse({ canceled: true, watch_id: '2' }))).not.toThrow();
    expect(() => stream.emitData(watchResponse({ watch_id: 'unknown' }))).toThrow(
      ClientRuntimeError,
    );
    stream.emitData(watchResponse({ watch_id: '3' }));
    expect(siblingData).toHaveBeenCalledOnce();
  });

  it('tears down a stream after its sole watcher is canceled during creation', async () => {
    const { manager, stream } = await createFakeWatchManager();
    const watcher = new Watcher(manager, NSApplicator.default, {});
    watcher.on('error', () => undefined);
    await waitForFirstWatchRequest(stream);

    stream.emitData(watchResponse({ created: true, canceled: true }));

    expect(stream.cancelCount).toBe(1);
  });

  it('settles cancel when the pending creation response is canceled', async () => {
    const { manager, stream } = await createFakeWatchManager();
    const watcher = new Watcher(manager, NSApplicator.default, {});
    await waitForFirstWatchRequest(stream);

    const canceled = watcher.cancel();
    stream.emitData(watchResponse({ created: true, canceled: true }));

    await expect(canceled).resolves.toBeUndefined();
    expect(stream.cancelCount).toBe(1);
  });

  it('emits the complete watch request while connecting', async () => {
    const { manager, stream } = await createFakeWatchManager();
    const watcher = new Watcher(manager, NSApplicator.default, { progress_notify: true });
    let received: RPC.IWatchRequest | undefined;
    watcher.on('connecting', request => (received = request));

    await waitForFirstWatchRequest(stream);

    expect(received).toEqual({ create_request: watcher.request });
    expect(received?.create_request).toBe(watcher.request);
  });

  it('continues attaching watchers when a connected listener throws', async () => {
    const deferred: (() => void)[] = [];
    const setImmediateSpy = vi
      .spyOn(global, 'setImmediate')
      .mockImplementation((callback: (...args: any[]) => void) => {
        deferred.push(callback);
        return {} as NodeJS.Immediate;
      });
    try {
      const { manager, stream } = await createFakeWatchManager();
      const first = new Watcher(manager, NSApplicator.default, {});
      const error = new Error('connected listener failed');
      first.on('connected', () => {
        throw error;
      });
      const second = new Watcher(manager, NSApplicator.default, {});
      await waitForFirstWatchRequest(stream);

      stream.emitData(watchResponse({ created: true, watch_id: '1' }));

      expect(stream.writes).toHaveLength(2);
      expect(stream.writes[1]).toEqual({ create_request: second.request });
      expect(deferred).toHaveLength(1);
      expect(deferred[0]).toThrow(error);
    } finally {
      setImmediateSpy.mockRestore();
    }
  });

  it('continues attaching when a connecting listener throws', async () => {
    const deferred: (() => void)[] = [];
    const setImmediateSpy = vi
      .spyOn(global, 'setImmediate')
      .mockImplementation((callback: (...args: any[]) => void) => {
        deferred.push(callback);
        return {} as NodeJS.Immediate;
      });
    try {
      const { manager, stream } = await createFakeWatchManager();
      const first = new Watcher(manager, NSApplicator.default, {});
      const error = new Error('connecting listener failed');
      first.on('connecting', () => {
        throw error;
      });
      const second = new Watcher(manager, NSApplicator.default, {});
      await waitForFirstWatchRequest(stream);

      stream.emitData(watchResponse({ created: true, watch_id: '1' }));

      expect(stream.writes).toHaveLength(2);
      expect(stream.writes[1]).toEqual({ create_request: second.request });
      expect(deferred).toHaveLength(1);
      expect(deferred[0]).toThrow(error);
    } finally {
      setImmediateSpy.mockRestore();
    }
  });

  it('settles pending cancellation before a throwing connected listener', async () => {
    const deferred: (() => void)[] = [];
    const setImmediateSpy = vi
      .spyOn(global, 'setImmediate')
      .mockImplementation((callback: (...args: any[]) => void) => {
        deferred.push(callback);
        return {} as NodeJS.Immediate;
      });
    try {
      const { manager, stream } = await createFakeWatchManager();
      const first = new Watcher(manager, NSApplicator.default, {});
      const error = new Error('connected listener failed');
      first.on('connected', () => {
        throw error;
      });
      const second = new Watcher(manager, NSApplicator.default, {});
      await waitForFirstWatchRequest(stream);

      const canceled = first.cancel();
      stream.emitData(watchResponse({ created: true, watch_id: '1' }));

      expect(stream.writes).toEqual([
        { create_request: first.request },
        { cancel_request: { watch_id: '1' } },
        { create_request: second.request },
      ]);
      expect(deferred).toHaveLength(1);
      expect(deferred[0]).toThrow(error);

      stream.emitData(watchResponse({ canceled: true, watch_id: '1' }));
      await expect(canceled).resolves.toBeUndefined();
    } finally {
      setImmediateSpy.mockRestore();
    }
  });

  it('settles pending cancellation before throwing disconnected and end listeners', async () => {
    const deferred: (() => void)[] = [];
    const setImmediateSpy = vi
      .spyOn(global, 'setImmediate')
      .mockImplementation((callback: (...args: any[]) => void) => {
        deferred.push(callback);
        return {} as NodeJS.Immediate;
      });
    try {
      const { manager: disconnectedManager, stream: disconnectedStream } =
        await createFakeWatchManager();
      const disconnectedWatcher = new Watcher(disconnectedManager, NSApplicator.default, {});
      const disconnectedError = new Error('disconnected listener failed');
      disconnectedWatcher.on('disconnected', () => {
        throw disconnectedError;
      });
      await waitForFirstWatchRequest(disconnectedStream);

      const disconnectedCancel = disconnectedWatcher.cancel();
      disconnectedStream.emitError(new Error('stream failed'));

      await expect(disconnectedCancel).resolves.toBeUndefined();
      expect(deferred).toHaveLength(1);
      expect(deferred[0]).toThrow(disconnectedError);

      const { manager: endManager, stream: endStream } = await createFakeWatchManager();
      const endWatcher = new Watcher(endManager, NSApplicator.default, {});
      const endError = new Error('end listener failed');
      endWatcher.on('end', () => {
        throw endError;
      });
      await waitForFirstWatchRequest(endStream);

      const endCancel = endWatcher.cancel();
      endStream.emitData(watchResponse({ created: true, canceled: true }));

      await expect(endCancel).resolves.toBeUndefined();
      expect(deferred).toHaveLength(2);
      expect(deferred[1]).toThrow(endError);
    } finally {
      setImmediateSpy.mockRestore();
    }
  });

  it('does not emit a stale end when attaching after a pending cancel disconnects', async () => {
    const { manager, stream } = await createFakeWatchManager();
    const canceledWatcher = new Watcher(manager, NSApplicator.default, {});
    let staleEnd = false;
    canceledWatcher.on('end', () => {
      staleEnd = true;
    });
    await waitForFirstWatchRequest(stream);

    const canceled = canceledWatcher.cancel();
    stream.emitError(new Error('stream failed'));
    await expect(canceled).resolves.toBeUndefined();

    const laterWatcher = new Watcher(manager, NSApplicator.default, {});
    await vi.waitFor(() => expect(stream.writes).toHaveLength(2));

    expect(stream.writes[1]).toEqual({ create_request: laterWatcher.request });
    expect(staleEnd).toBe(false);
  });
});

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

  async function cleanUpNetworkInterruption(
    watcher: Watcher | undefined,
    proxiedClient: Etcd3 | undefined,
  ) {
    try {
      try {
        await proxy.unsuspend();
      } finally {
        await watcher?.cancel();
      }
    } finally {
      try {
        proxiedClient?.close();
      } finally {
        await proxy.deactivate();
      }
    }
  }

  describe('network interruptions', () => {
    it('is resilient to network interruptions', async () => {
      let proxiedClient: Etcd3 | undefined;
      let watcher: Watcher | undefined;

      try {
        await proxy.activate();
        proxiedClient = await createTestClientAndKeys();
        watcher = await proxiedClient.watch().key('foo1').create();
        const activeWatcher = watcher;

        const disconnected = onceEvent(activeWatcher, 'disconnected', 'error');
        await proxy.suspend();
        await disconnected;

        const connected = onceEvent(activeWatcher, 'connected', 'error');
        await proxy.unsuspend();
        await connected;
        await expectWatching(activeWatcher, 'foo1');
      } finally {
        await cleanUpNetworkInterruption(watcher, proxiedClient);
      }
    });

    it('replays historical updates', async () => {
      let proxiedClient: Etcd3 | undefined;
      let watcher: Watcher | undefined;

      try {
        await proxy.activate();
        proxiedClient = await createTestClientAndKeys();
        watcher = await proxiedClient.watch().key('foo1').create();
        const activeWatcher = watcher;

        const firstUpdate = onceEvent(activeWatcher, 'data', 'error').then(
          (res: IWatchResponse) => {
            expect(activeWatcher.request.start_revision).toBe(
              (BigInt(res.header.revision) + 1n).toString(),
            );
          },
        );
        await Promise.all([client.put('foo1').value('update 1'), firstUpdate]);

        const disconnected = onceEvent(activeWatcher, 'disconnected', 'error');
        await proxy.suspend();
        await disconnected;

        const replayedUpdate = onceEvent(activeWatcher, 'data', 'error').then(
          (res: IWatchResponse) => {
            expect(res.events).toHaveLength(1);
            expect(res.events[0].kv.key.toString()).toBe('foo1');
            expect(res.events[0].kv.value.toString()).toBe('update 2');
            return res;
          },
        );
        const missedUpdate = await client.put('foo1').value('update 2');

        const connected = onceEvent(activeWatcher, 'connected', 'error');
        await proxy.unsuspend();
        await Promise.all([connected, replayedUpdate]);
        expect(activeWatcher.request.start_revision).toBe(
          (BigInt(missedUpdate.header.revision) + 1n).toString(),
        );
      } finally {
        await cleanUpNetworkInterruption(watcher, proxiedClient);
      }
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

        it('continues attaching queued watchers after a creation rejection', async () => {
          const authedClient = new Etcd3(
            getOptions({
              auth: {
                username: 'connor',
                password: 'password',
              },
            }),
          );
          const rejectedWatcher = authedClient.watch().key('outside of range').watcher();
          let rejectedConnected = false;
          rejectedWatcher.on('connected', () => (rejectedConnected = true));
          const rejected = onceEvent(rejectedWatcher, 'error');
          const validWatcher = authedClient.watch().key('foo').watcher();
          const connected = onceEvent(validWatcher, 'connected', 'error');

          try {
            await expect(rejected).rejects.toThrow(EtcdPermissionDeniedError);
            expect(rejectedWatcher.id).toBeNull();
            expect(rejectedConnected).toBe(false);

            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error('queued valid watcher did not connect')),
                5_000,
              );
              connected.then(
                () => {
                  clearTimeout(timeout);
                  resolve();
                },
                error => {
                  clearTimeout(timeout);
                  reject(error);
                },
              );
            });
          } finally {
            if (validWatcher.id !== null) {
              await validWatcher.cancel();
            }
            authedClient.close();
          }
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
