import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PrimaryCollectionTimeoutError,
  runPrimaryScheduled,
} from '../worker/src/main.js';

const controller = { cron: '* * * * *' };
const ctx = { waitUntil() {} };

test('scheduled collector watchdog rejects a flight that never settles', async () => {
  await assert.rejects(
    runPrimaryScheduled(
      controller,
      {},
      ctx,
      () => new Promise(() => {}),
      15,
    ),
    (error) => {
      assert.ok(error instanceof PrimaryCollectionTimeoutError);
      assert.equal(error.code, 'PRIMARY_COLLECTION_TIMEOUT');
      assert.equal(error.timeoutMs, 15);
      assert.match(error.message, /timed out after 15ms/);
      return true;
    },
  );
});

test('the cron after a timed-out flight can start and finish normally', async () => {
  await assert.rejects(
    runPrimaryScheduled(controller, {}, ctx, () => new Promise(() => {}), 10),
    PrimaryCollectionTimeoutError,
  );

  const result = await runPrimaryScheduled(
    controller,
    {},
    ctx,
    async () => ({ ok: true, recovered: true }),
    1000,
  );
  assert.deepEqual(result, { ok: true, recovered: true });
});

test('successful scheduled collection is not delayed by the watchdog', async () => {
  const result = await runPrimaryScheduled(
    controller,
    {},
    ctx,
    async () => 'complete',
    1000,
  );
  assert.equal(result, 'complete');
});
