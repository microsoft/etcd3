/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { expect } from 'chai';
import { Isolation, SoftwareTransaction } from '../stm';

import { Etcd3, Namespace, STMConflictError } from '..';
import { createTestClient, createTestKeys, tearDownTestClient } from './util';

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
        expect(await ns.stm().transact(() => 'foo')).to.equal('foo');
      });

      const expectRetry = async (
        isolation: Isolation,
        fn: (tx: SoftwareTransaction, tries: number) => Promise<any>,
        retries = 2,
      ) => {
        let tries = 0;
        await ns.stm({ isolation }).transact(async tx => fn(tx, ++tries));
        expect(tries).to.equal(retries);
      };

      const expectRunsCleanTransaction = (isolation: Isolation) => {
        it('runs transactions when all is good', async () => {
          await ns.stm({ isolation }).transact(async tx => {
            const value = await tx.get('foo1');
            await tx.put('foo1').value(value!.repeat(3));
            expect(await ns.get('foo1')).to.equal('bar1'); // should not have changed yet
          });

          expect(await ns.get('foo1')).to.equal('bar1bar1bar1');
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
            expect(await tx.get('foo').string()).to.equal('some value');
          });
        });

        it('caches writes in memory (#2)', async () => {
          return ignoreConflicts(isolation, async tx => {
            // getting a value, then overwriting it, should return the overwritten value
            expect(await tx.get('foo1').string()).to.equal('bar1');
            await tx.put('foo1').value('lol');
            expect(await tx.get('foo1').string()).to.equal('lol');
          });
        });

        it('caches writes in memory (#3)', async () => {
          return ignoreConflicts(isolation, async tx => {
            // deleting a value should null it
            await tx.delete().key('foo1');
            expect(await tx.get('foo1').string()).to.be.null;

            // subsequently writing a key should put it back
            await tx.put('foo1').value('lol');
            expect(await tx.get('foo1').string()).to.equal('lol');
          });
        });

        it('caches writes in memory (#4)', async () => {
          return ignoreConflicts(isolation, async tx => {
            // deleting a range should null all keys in that range
            await tx.delete().prefix('foo');
            expect(await tx.get('foo2').string()).to.be.null;
          });
        });
      };

      const expectReadCaching = (isolation: Isolation) => {
        it('caches reads in memory', async () => {
          return ns
            .stm({ retries: 0, isolation })
            .transact(async tx => {
              expect(await tx.get('foo1').string()).to.equal('bar1');
              await ns.put('foo1').value('changed!');
              expect(await tx.get('foo1').string()).to.equal('bar1');
            })
            .catch(() => undefined);
        });
      };

      describe('ReadCommitted', () => {
        expectWriteCaching(Isolation.ReadCommitted);
        expectRunsCleanTransaction(Isolation.ReadCommitted);
      });

      describe('RepeatableReads', () => {
        expectWriteCaching(Isolation.RepeatableReads);
        expectRunsCleanTransaction(Isolation.RepeatableReads);
        expectRepeatableReads(Isolation.RepeatableReads);
      });

      describe('Serializable', () => {
        expectWriteCaching(Isolation.Serializable);
        expectRunsCleanTransaction(Isolation.Serializable);
        expectRepeatableReads(Isolation.Serializable);
        expectReadCaching(Isolation.Serializable);
      });

      describe('SerializableSnapshot', () => {
        expectWriteCaching(Isolation.SerializableSnapshot);
        expectRunsCleanTransaction(Isolation.SerializableSnapshot);
        expectRepeatableReads(Isolation.SerializableSnapshot);
        expectReadCaching(Isolation.SerializableSnapshot);

        it('should deny writing ranges if keys are read', () => {
          return expect(
            ignoreConflicts(Isolation.SerializableSnapshot, async tx => {
              await tx.get('foo1').string();
              await tx.delete().prefix('foo');
            }),
          ).to.eventually.be.rejectedWith(/You cannot delete ranges/);
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

          expect(await ns.get('foo1')).to.equal('lollollol');
        });

        it('retries deletes on conflicts', async () => {
          await expectRetry(Isolation.SerializableSnapshot, async (tx, tries) => {
            await tx.get('foo1');
            if (tries === 1) {
              await ns.put('foo1').value('lol');
            }
            await tx.delete().key('foo1');
          });

          expect(await ns.get('foo1')).to.null;
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
          ).to.eventually.be.rejectedWith(STMConflictError);
        });
      });
    }),
  );
});
