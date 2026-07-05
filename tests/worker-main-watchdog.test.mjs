import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PrimaryCollectionTimeoutError,
  resetPrimaryScheduledFlightForTests,
  runPrimaryCycle,
  runPrimaryScheduled,
} from '../worker/src/scheduled-main.js';

const controller = { cron: '* * * * *' };
const noAuxiliary = {
  weekly: async () => {},
  host: async () => {},
};

function recordingContext() {
  const tasks = [];
  return {
    ctx: {
      waitUntil(task) {
        tasks.push(task);
      },
    },
    async settle() {
      await Promise.all(tasks);
    },
  };
}

test.beforeEach(() => {
  resetPrimaryScheduledFlightForTests();
});

test('scheduled collector watchdog rejects and resets a flight that never settles', async () => {
  const context = recordingContext();
  let resets = 0;
  await assert.rejects(
    runPrimaryScheduled(
      controller,
      {},
      context.ctx,
      () => new Promise(() => {}),
      15,
      {
        auxiliaryRunners: noAuxiliary,
        resetCollectionFlight: () => { resets += 1; },
      },
    ),
    (error) => {
      assert.ok(error instanceof PrimaryCollectionTimeoutError);
      assert.equal(error.code, 'PRIMARY_COLLECTION_TIMEOUT');
      assert.equal(error.timeoutMs, 15);
      return true;
    },
  );
  await context.settle();
  assert.equal(resets, 1);
});

test('the cron after a timed-out flight can start and finish normally', async () => {
  const firstContext = recordingContext();
  let starts = 0;
  await assert.rejects(
    runPrimaryScheduled(
      controller,
      {},
      firstContext.ctx,
      () => {
        starts += 1;
        return new Promise(() => {});
      },
      10,
      { auxiliaryRunners: noAuxiliary, resetCollectionFlight: () => {} },
    ),
    PrimaryCollectionTimeoutError,
  );
  await firstContext.settle();

  const secondContext = recordingContext();
  const result = await runPrimaryScheduled(
    controller,
    {},
    secondContext.ctx,
    async () => {
      starts += 1;
      return { ok: true, recovered: true };
    },
    1000,
    { auxiliaryRunners: noAuxiliary },
  );
  await secondContext.settle();
  assert.deepEqual(result, { ok: true, recovered: true });
  assert.equal(starts, 2);
});

test('a pending auxiliary task does not suppress the next primary cron', async () => {
  let releaseAuxiliary;
  const auxiliaryGate = new Promise((resolve) => { releaseAuxiliary = resolve; });
  const runners = {
    weekly: () => auxiliaryGate,
    host: async () => {},
  };
  let starts = 0;
  const firstContext = recordingContext();
  assert.equal(await runPrimaryScheduled(
    controller,
    {},
    firstContext.ctx,
    async () => {
      starts += 1;
      return 'first';
    },
    1000,
    { auxiliaryRunners: runners },
  ), 'first');

  const secondContext = recordingContext();
  assert.equal(await runPrimaryScheduled(
    controller,
    {},
    secondContext.ctx,
    async () => {
      starts += 1;
      return 'second';
    },
    1000,
    { auxiliaryRunners: runners },
  ), 'second');
  assert.equal(starts, 2);

  releaseAuxiliary();
  await Promise.all([firstContext.settle(), secondContext.settle()]);
});

test('successful primary cycles never expire a lease using a throttled timestamp', async () => {
  let expirations = 0;
  const result = await runPrimaryCycle(controller, {}, {}, {}, {
    runPrimary: async () => 'complete',
    expireLease: async () => { expirations += 1; },
  });
  assert.equal(result, 'complete');
  assert.equal(expirations, 0);
});

test('failed primary cycles expire the lease and preserve the primary error', async () => {
  let expirations = 0;
  const expected = new Error('primary failed');
  await assert.rejects(
    runPrimaryCycle(controller, {}, {}, {}, {
      runStartedAt: 1234,
      runPrimary: async () => { throw expected; },
      expireLease: async (_env, startedAt) => {
        assert.equal(startedAt, 1234);
        expirations += 1;
      },
    }),
    (error) => error === expected,
  );
  assert.equal(expirations, 1);
});
