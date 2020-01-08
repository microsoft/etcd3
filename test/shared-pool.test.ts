import { expect } from 'chai';
import * as sinon from 'sinon';

import { ExponentialBackoff } from '../src/backoff/exponential';
import { SharedPool } from '../src/shared-pool';

describe('shared pool', () => {
  let pool: SharedPool<number>;
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers(10);
    pool = new SharedPool<number>(
      new ExponentialBackoff({
        initial: 500,
        max: 5000,
        random: 0,
      }),
    );
    pool.add(0);
    pool.add(1);
    pool.add(2);
  });

  afterEach(() => clock.restore());

  async function getAll(count: number = 3): Promise<number[]> {
    const output: number[] = [];
    for (let i = 0; i < count; i += 1) {
      clock.tick(1);
      output.push(await pool.pull());
    }

    return output;
  }

  it('should get available clients', async () => {
	expect(await getAll()).to.deep.equal([0, 1, 2]);
  });

  it('should exclude clients after failing', async () => {
    pool.fail(0);
    expect(await getAll()).to.deep.equal([1, 2, 1]);
  });

  it('should add clients back and continue backing off', async () => {
    pool.fail(0);
    expect(await getAll()).to.deep.equal([1, 2, 1]);
    clock.tick(500);
    expect(await getAll()).to.deep.equal([0, 2, 1]);

    pool.fail(0);
    clock.tick(500);
    expect(await getAll()).to.deep.equal([2, 1, 2]);
    clock.tick(500);
    expect(await getAll()).to.deep.equal([0, 1, 2]);
  });

  it('should add clients back and reset if they succeed', async () => {
    pool.fail(0);
    expect(await getAll()).to.deep.equal([1, 2, 1]);
    clock.tick(500);
    expect(await getAll()).to.deep.equal([0, 2, 1]);
    pool.succeed(0);

    pool.fail(0);
    clock.tick(500);
    expect(await getAll()).to.deep.equal([0, 2, 1]);
  });

  it('should not back off multiple times if multiple callers fail', async () => {
    const getFirstBackoff = (): number => (pool as any).resources[0].availableAfter;
    const cnx = await pool.pull();
    pool.fail(cnx);
    expect(getFirstBackoff()).to.equal(Date.now() + 500);
    pool.fail(cnx);
    expect(getFirstBackoff()).to.equal(Date.now() + 500);
  });
});
