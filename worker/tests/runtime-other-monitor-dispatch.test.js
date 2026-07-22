import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchStreamPrediction } from '../src/runtime-stream-prediction-dispatch.js';
import { runRuntimeQueue } from '../src/runtime-queue.js';

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

test('runtime prediction executes only at the two scheduled minute slots', async () => {
  const calls = [];
  const dependencies = {
    prediction: async (_env, scheduledAt) => {
      calls.push(scheduledAt);
      return { ok: true, scheduled_at: scheduledAt };
    },
  };

  const first = await dispatchStreamPrediction(
    { scheduledTime: BASE + 10 * 60_000 },
    {},
    {},
    { dependencies },
  );
  const second = await dispatchStreamPrediction(
    { scheduledTime: BASE + 40 * 60_000 },
    {},
    {},
    { dependencies },
  );
  const idle = await dispatchStreamPrediction(
    { scheduledTime: BASE + 25 * 60_000 },
    {},
    {},
    { dependencies },
  );

  assert.deepEqual(calls, [BASE + 10 * 60_000, BASE + 40 * 60_000]);
  assert.equal(first[0].ok, true);
  assert.equal(second[0].ok, true);
  assert.deepEqual(idle, [{ skipped: true, reason: 'stream-prediction-not-due' }]);
});

test('successful prediction invalidates the runtime health cache once', async () => {
  let invalidations = 0;
  await dispatchStreamPrediction(
    { scheduledTime: BASE + 10 * 60_000 },
    {},
    {},
    {
      dependencies: { prediction: async () => ({ ok: true }) },
      healthApp: { invalidateHealthCache() { invalidations += 1; } },
    },
  );
  assert.equal(invalidations, 1);
});

test('unknown runtime queue messages are discarded without loading a legacy monitor', async () => {
  const calls = [];
  await runRuntimeQueue({ messages: [{
    body: { message_type: 'retired-monitor-task' },
    ack() { calls.push('ack'); },
    retry() { calls.push('retry'); },
  }] }, {}, {});
  assert.deepEqual(calls, ['ack']);
});
