/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Isolation } from '../stm.js';
import type { SoftwareTransaction } from '../stm.js';
import { Etcd3, STMConflictError } from '../index.js';
import type { Namespace } from '../index.js';
import { createTestClient, createTestKeys, tearDownTestClient } from './util.js';

describe('stm()', () => {
  [
    {
      namespace: false,
      name: 'without namespace',
    },
    {
      namespace: true,
      name: 'with namespace',
    },
  ].forEach(testcase =>
    describe(testcase.name, () => {
      let client: Etcd3;
      let ns: Namespace;

      beforeEach(async () => {
        client = await createTestClient();
        ns = testcase.namespace ? client.namespace('ns/') : client;
        await createTestKeys(ns);
      });

      afterEach(async () => await tearDownTestClient(client));

      it('executes empty transactions', async () => {
        expect(await ns.stm().transact(() => 'foo')).toBe('foo');
      });

      const expectRetry = async (
        isolation: Isolation,
        fn: (tx: SoftwareTransaction, tries: number) => Promise<any>,
        retries = 2,
      ) => {
        let tries = 0;
        await ns.stm({ isolation }).transact(async tx => fn(tx, ++tries));
        expect(tries).toBe(retries);
      };

      const expectRunsCleanTransaction = (isolation: Isolation) => {
        it('runs transactions when all is good', async () => {
          await ns.stm({ isolation }).transact(async tx => {
            const value = await tx.get('foo1');
            await tx.put('foo1').value(value!.repeat(3));
            expect(await ns.get('foo1')).toBe('bar1'); // should not have changed yet
          });

          expect(await ns.get('foo1')).toBe('bar1bar1bar1');
        });
      };

      const expectRepeatableReads = (isolation: Isolation) => {
        it('has repeatable reads on existing keys', async () => {
          await expectRetry(isolation, async (tx, tries) => {
            await tx.get('foo1');
            if (tries === 1) {
              // should fail when the key changes before the transaction commits
              await ns.put('foo1').value('lol');
            }
          });
        });

        it('has repeatable reads on non-existent', async () => {
          await expectRetry(isolation, async (tx, tries) => {
            await tx.get('some-key-that-does-not-exist');
            if (tries === 1) {
              await ns.put('some-key-that-does-not-exist').value('lol');
            }
          });
        });
      };

      const ignoreConflicts = (
        isolation: Isolation,
        fn: (tx: SoftwareTransaction) => Promise<any>,
      ) => {
        return ns
          .stm({ retries: 0, isolation })
          .transact(fn)
          .catch(err => {
            if (!(err instanceof STMConflictError)) {
              throw err;
            }
          });
      };

      const expectWriteCaching = (isolation: Isolation) => {
        it('caches writes in memory (#1)', () => {
          return ignoreConflicts(isolation, async tx => {
            // putting and value and getting it should returned the value to be written
            await tx.put('foo').value('some value');
            expect(await tx.get('foo').string()).toBe('some value');
          });
        });

        it('caches writes in memory (#2)', async () => {
          return ignoreConflicts(isolation, async tx => {
            // getting a value, then overwriting it, should return the overwritten value
            expect(await tx.get('foo1').string()).toBe('bar1');
            await tx.put('foo1').value('lol');
            expect(await tx.get('foo1').string()).toBe('lol');
          });
        });

        it('caches writes in memory (#3)', async () => {
          return ignoreConflicts(isolation, async tx => {
            // deleting a value should null it
            await tx.delete().key('foo1');
            expect(await tx.get('foo1').string()).toBeNull();

            // subsequently writing a key should put it back
            await tx.put('foo1').value('lol');
            expect(await tx.get('foo1').string()).toBe('lol');
          });
        });

        it('caches writes in memory (#4)', async () => {
          return ignoreConflicts(isolation, async tx => {
            // deleting a range should null all keys in that range
            await tx.delete().prefix('foo');
            expect(await tx.get('foo2').string()).toBeNull();
          });
        });

        it('caches the existing value when touching a key', async () => {
          return ignoreConflicts(isolation, async tx => {
            await tx.put('foo1').touch();
            expect(await tx.get('foo1').string()).toBe('bar1');
          });
        });
      };

      const expectReadCaching = (isolation: Isolation) => {
        it('caches reads in memory', async () => {
          return ns
            .stm({ retries: 0, isolation })
            .transact(async tx => {
              expect(await tx.get('foo1').string()).toBe('bar1');
              await ns.put('foo1').value('changed!');
              expect(await tx.get('foo1').string()).toBe('bar1');
            })
            .catch(() => undefined);
        });
      };

      const expectValueReadsAfterExists = (isolation: Isolation) => {
        it('keeps cached values after an existence read', async () => {
          await ns.put('value-read').value('42');

          await ns.stm({ retries: 0, isolation }).transact(async tx => {
            expect(await tx.get('value-read').exists()).toBe(true);
            expect(await tx.get('value-read').string()).toBe('42');
            expect((await tx.get('value-read').buffer())?.toString()).toBe('42');
            expect(await tx.get('value-read').number()).toBe(42);
          });
        });
      };

      const expectPrefetchValueReads = (isolation: Isolation) => {
        it('uses a prefetched value for existence and value reads', async () => {
          const range = vi.spyOn(ns.kv, 'range');
          try {
            await ns.stm({ retries: 0, isolation, prefetch: ['foo1'] }).transact(async tx => {
              expect(await tx.get('foo1').exists()).toBe(true);
              expect(await tx.get('foo1').string()).toBe('bar1');
            });

            expect(range).toHaveBeenCalledTimes(1);
          } finally {
            range.mockRestore();
          }
        });
      };

      const expectDeleteThenTouch = (isolation: Isolation) => {
        it('preserves a point deletion when its key is touched', async () => {
          await ns.stm({ retries: 0, isolation }).transact(async tx => {
            await tx.delete().key('foo1');
            await tx.put('foo1').touch();

            expect(await tx.get('foo1').string()).toBeNull();
          });

          expect(await ns.get('foo1')).toBeNull();
        });

        it('preserves a range deletion when one of its keys is touched', async () => {
          await ns.put('touch/a').value('a');
          await ns.put('touch/b').value('b');

          await ns.stm({ retries: 0, isolation }).transact(async tx => {
            await tx.delete().prefix('touch/');
            await tx.put('touch/a').touch();

            expect(await tx.get('touch/a').string()).toBeNull();
          });

          expect(await ns.get('touch/a')).toBeNull();
          expect(await ns.get('touch/b')).toBeNull();
        });
      };

      describe('ReadCommitted', () => {
        expectWriteCaching(Isolation.ReadCommitted);
        expectRunsCleanTransaction(Isolation.ReadCommitted);
        expectDeleteThenTouch(Isolation.ReadCommitted);

        it('reads committed updates without bypassing local writes or deletes', async () => {
          await ns.stm({ isolation: Isolation.ReadCommitted }).transact(async tx => {
            expect(await tx.get('foo1').string()).toBe('bar1');
            await ns.put('foo1').value('committed update');
            expect(await tx.get('foo1').string()).toBe('committed update');

            await tx.put('foo1').value('local write');
            await ns.put('foo1').value('newer committed update');
            expect(await tx.get('foo1').string()).toBe('local write');

            await tx.delete().key('foo1');
            await ns.put('foo1').value('another committed update');
            expect(await tx.get('foo1').string()).toBeNull();
          });

          expect(await ns.get('foo1')).toBeNull();
        });

        it('touches the value committed before it reaches the server', async () => {
          const txn = vi.spyOn(ns.kv, 'txn');
          try {
            await ns.stm({ isolation: Isolation.ReadCommitted }).transact(async tx => {
              await tx.put('foo1').touch();
              await ns.put('foo1').value('concurrent');
            });

            const put = txn.mock.lastCall?.[0].success?.find(op => op.request_put);
            expect(put?.request_put).toMatchObject({ ignore_value: true, value: undefined });
          } finally {
            txn.mockRestore();
          }

          expect(await ns.get('foo1')).toBe('concurrent');
        });

        it('preserves a preceding local put when touching', async () => {
          await ns.stm({ isolation: Isolation.ReadCommitted }).transact(async tx => {
            await tx.put('foo1').value('local');
            await tx.put('foo1').touch();
            await ns.put('foo1').value('concurrent');

            expect(await tx.get('foo1').string()).toBe('local');
          });

          expect(await ns.get('foo1')).toBe('local');
        });
      });

      describe('transaction ownership', () => {
        it('rejects concurrent calls and permits sequential reuse', async () => {
          const stm = ns.stm({ isolation: Isolation.ReadCommitted });
          let releaseFirst!: () => void;
          let signalStarted!: () => void;
          const started = new Promise<void>(resolve => {
            signalStarted = resolve;
          });
          const first = stm.transact(async tx => {
            await tx.put('first').value('first');
            signalStarted();
            await new Promise<void>(resolve => {
              releaseFirst = resolve;
            });
          });
          await started;

          const second = vi.fn(async (tx: SoftwareTransaction) => {
            await tx.put('second').value('second');
          });
          await expect(stm.transact(second)).rejects.toThrow(/another transact\(\) call is active/);
          expect(second).not.toHaveBeenCalled();

          releaseFirst();
          await first;
          expect(await ns.get('first')).toBe('first');
          expect(await ns.get('second')).toBeNull();

          await stm.transact(tx => tx.put('sequential').value('sequential'));
          expect(await ns.get('sequential')).toBe('sequential');
        });

        it('releases ownership after callback and commit failures', async () => {
          const stm = ns.stm({ isolation: Isolation.SerializableSnapshot, retries: 0 });

          await expect(
            stm.transact(() => {
              throw new Error('callback failure');
            }),
          ).rejects.toThrow('callback failure');
          await stm.transact(tx => tx.put('after-callback-failure').value('success'));

          await expect(
            stm.transact(async tx => {
              await tx.get('foo1');
              await ns.put('foo1').value('conflict');
            }),
          ).rejects.toThrow(STMConflictError);
          await stm.transact(tx => tx.put('after-commit-failure').value('success'));
        });

        it('releases ownership after a completed retry', async () => {
          const stm = ns.stm({ isolation: Isolation.SerializableSnapshot, retries: 1 });
          let attempts = 0;

          await stm.transact(async tx => {
            const value = await tx.get('foo1').string();
            if (++attempts === 1) {
              await ns.put('foo1').value('conflict');
            }
            await tx.put('foo1').value(`${value}-updated`);
          });

          expect(attempts).toBe(2);
          await stm.transact(tx => tx.put('after-retry').value('success'));
          expect(await ns.get('after-retry')).toBe('success');
        });
      });

      describe('RepeatableReads', () => {
        expectWriteCaching(Isolation.RepeatableReads);
        expectRunsCleanTransaction(Isolation.RepeatableReads);
        expectRepeatableReads(Isolation.RepeatableReads);
        expectValueReadsAfterExists(Isolation.RepeatableReads);
        expectDeleteThenTouch(Isolation.RepeatableReads);
      });

      describe('Serializable', () => {
        expectWriteCaching(Isolation.Serializable);
        expectRunsCleanTransaction(Isolation.Serializable);
        expectRepeatableReads(Isolation.Serializable);
        expectReadCaching(Isolation.Serializable);
        expectValueReadsAfterExists(Isolation.Serializable);
        expectPrefetchValueReads(Isolation.Serializable);
        expectDeleteThenTouch(Isolation.Serializable);
      });

      describe('SerializableSnapshot', () => {
        expectWriteCaching(Isolation.SerializableSnapshot);
        expectRunsCleanTransaction(Isolation.SerializableSnapshot);
        expectRepeatableReads(Isolation.SerializableSnapshot);
        expectReadCaching(Isolation.SerializableSnapshot);
        expectValueReadsAfterExists(Isolation.SerializableSnapshot);
        expectPrefetchValueReads(Isolation.SerializableSnapshot);
        expectDeleteThenTouch(Isolation.SerializableSnapshot);

        it('should deny writing ranges if keys are read', () => {
          return expect(
            ignoreConflicts(Isolation.SerializableSnapshot, async tx => {
              await tx.get('foo1').string();
              await tx.delete().prefix('foo');
            }),
          ).rejects.toThrow(/You cannot delete ranges/);
        });

        // the blueprint for the next two is:
        // 1. get foo1
        // 2. outside the transaction, set it to something else
        // 3. try to writed/delete it and fail
        // 4. get foo1, this time write it succesfully to what was set before

        it('retries writes on conflicts', async () => {
          await expectRetry(Isolation.SerializableSnapshot, async (tx, tries) => {
            const value = await tx.get('foo1');
            if (tries === 1) {
              await ns.put('foo1').value('lol');
            }

            await tx.put('foo1').value(value!.repeat(3));
          });

          expect(await ns.get('foo1')).toBe('lollollol');
        });

        it('retries deletes on conflicts', async () => {
          await expectRetry(Isolation.SerializableSnapshot, async (tx, tries) => {
            await tx.get('foo1');
            if (tries === 1) {
              await ns.put('foo1').value('lol');
            }
            await tx.delete().key('foo1');
          });

          expect(await ns.get('foo1')).toBeNull();
        });

        it('commits writes to newer keys in its snapshot', async () => {
          await ns.put('snapshot/a').value('older');
          await ns.put('snapshot/b').value('newer');

          await expect(
            ns.stm({ isolation: Isolation.SerializableSnapshot, retries: 0 }).transact(async tx => {
              expect(await tx.get('snapshot/a').string()).toBe('older');
              expect(await tx.get('snapshot/b').string()).toBe('newer');
              await tx.put('snapshot/b').value('updated');
            }),
          ).resolves.toBeUndefined();

          expect(await ns.get('snapshot/b')).toBe('updated');
        });

        it('aborts transactions on continous failure', async () => {
          await expect(
            ns
              .stm({ isolation: Isolation.SerializableSnapshot })
              .transact(async tx => {
                const value = await tx.get('foo1');
                await ns.put('foo1').value('lol');
                await tx.put('foo1').value(value!.repeat(3));
              })
              .then(() => {
                throw new Error('expected to throw');
              }),
          ).rejects.toThrow(STMConflictError);
        });
      });

      describe('overlapping writes', () => {
        it('splits an earlier range deletion around a later put', async () => {
          await ns.put('overlap/a').value('a');
          await ns.put('overlap/b').value('b');
          await ns.put('overlap/c').value('c');

          await ns.stm({ isolation: Isolation.ReadCommitted }).transact(async tx => {
            await tx.delete().prefix('overlap/');
            await tx.put('overlap/b').value('replacement');

            expect(await tx.get('overlap/a').string()).toBeNull();
            expect(await tx.get('overlap/b').string()).toBe('replacement');
            expect(await tx.get('overlap/c').string()).toBeNull();
          });

          expect(await ns.get('overlap/a')).toBeNull();
          expect(await ns.get('overlap/b')).toBe('replacement');
          expect(await ns.get('overlap/c')).toBeNull();
        });

        it('splits an earlier range deletion around a later point deletion', async () => {
          await ns.put('overlap/a').value('a');
          await ns.put('overlap/b').value('b');
          await ns.put('overlap/c').value('c');

          const txn = vi.spyOn(ns.kv, 'txn');
          try {
            await ns.stm({ isolation: Isolation.ReadCommitted }).transact(async tx => {
              await tx.delete().prefix('overlap/');
              await tx.delete().key('overlap/b');

              expect(await tx.get('overlap/a').string()).toBeNull();
              expect(await tx.get('overlap/b').string()).toBeNull();
              expect(await tx.get('overlap/c').string()).toBeNull();
            });

            const key = Buffer.from(`${testcase.namespace ? 'ns/' : ''}overlap/b`);
            const operations = txn.mock.lastCall?.[0].success;
            expect(operations).toBeDefined();
            expect(
              operations!.filter(({ request_delete_range: deletion }) => {
                const end = deletion?.range_end;
                return (
                  end &&
                  end.length > 0 &&
                  deletion!.key!.compare(key) <= 0 &&
                  (end.equals(Buffer.from([0])) || end.compare(key) > 0)
                );
              }),
            ).toHaveLength(0);
          } finally {
            txn.mockRestore();
          }

          expect(await ns.get('overlap/a')).toBeNull();
          expect(await ns.get('overlap/b')).toBeNull();
          expect(await ns.get('overlap/c')).toBeNull();
        });

        it('treats an empty inRange endpoint as a point deletion', async () => {
          await ns.put('a').value('a');
          await ns.put('ab').value('ab');

          await ns.stm({ isolation: Isolation.ReadCommitted }).transact(async tx => {
            await tx.delete().inRange('a');

            expect(await tx.get('a').string()).toBeNull();
            expect(await tx.get('ab').string()).toBe('ab');
          });

          expect(await ns.get('a')).toBeNull();
          expect(await ns.get('ab')).toBe('ab');
        });
      });
    }),
  );
});
