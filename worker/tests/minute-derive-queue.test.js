import assert from 'node:assert/strict';
import test from 'node:test';

import {
  minuteDeriveTrigger,
  parseMinuteDeriveTrigger,
  processMinuteDeriveTrigger,
} from '../src/minute-derive-queue.js';
import { dispatchPendingMinuteFacts } from '../src/minute-maintenance-entry.js';

const trigger = minuteDeriveTrigger({ channel_id: 10, minute_at: 120_000 });

function job(overrides = {}) {
  return {
    id: 7,
    channel_id: 10,
    minute_at: 120_000,
    payload_version: 1,
    payload_json: JSON.stringify({
      payload_version: 1,
      observedAt: 123_456,
      snapshot: { channel_id: 10 },
      queue: null,
      comments: {},
      rebuild: null,
    }),
    job_kind: 'live',
    attempts: 1,
    ...overrides,
  };
}

test('minute derive triggers have a stable idempotency identity', () => {
  assert.deepEqual(trigger, {
    message_type: 'minute-fact-derive',
    message_version: 1,
    job_id: 'minute-fact:10:120000',
    channel_id: 10,
    minute_at: 120_000,
  });
  assert.deepEqual(parseMinuteDeriveTrigger(trigger), trigger);
  assert.throws(
    () => parseMinuteDeriveTrigger({ ...trigger, job_id: 'wrong' }),
    /job_id does not match/,
  );
});

test('derive Queue processing claims and completes exactly one job', async () => {
  const calls = [];
  const result = await processMinuteDeriveTrigger({ MINUTE_DB: {} }, trigger, {
    now: () => 200_000,
    claim: async () => { calls.push('claim'); return job(); },
    write: async (_env, payload) => { calls.push(`write:${payload.snapshot.channel_id}`); },
    complete: async (_env, id) => { calls.push(`complete:${id}`); },
    stats: async () => ({ pending_count: 2, processing_count: 0, dead_count: 0 }),
  });

  assert.deepEqual(calls, ['claim', 'write:10', 'complete:7']);
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.pending_count, 2);
});

test('derive Queue processing persists failure before requesting a retry', async () => {
  let failedOptions = null;
  const result = await processMinuteDeriveTrigger({ MINUTE_DB: {} }, trigger, {
    now: () => 200_000,
    claim: async () => job({ attempts: 2 }),
    write: async () => { throw new Error('D1 unavailable'); },
    fail: async (_env, _job, _error, options) => {
      failedOptions = options;
      return { terminal: false };
    },
    stats: async () => ({ pending_count: 1, processing_count: 0, dead_count: 0 }),
  });

  assert.equal(result.failed, 1);
  assert.equal(result.terminal, false);
  assert.equal(result.retry_delay_ms, 120_000);
  assert.equal(failedOptions.retryDelayMs, 120_000);
});

test('maintenance dispatches bounded orphan and backlog triggers in one Queue batch', async () => {
  const batches = [];
  const result = await dispatchPendingMinuteFacts({
    DERIVE_DISPATCH_LIMIT: 5,
    MINUTE_DERIVE_QUEUE: {
      async send() {},
      async sendBatch(batch) { batches.push(batch); },
    },
  }, {
    load: async (_env, options) => {
      assert.equal(options.limit, 5);
      return [trigger, minuteDeriveTrigger({ channel_id: 11, minute_at: 180_000 })];
    },
  });

  assert.equal(result.dispatched, 2);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  assert.equal(batches[0][0].contentType, 'json');
});
