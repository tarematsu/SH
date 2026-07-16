import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveConfig,
  minuteFactRetryDelayMs,
  runMinuteFactDeriveCron,
} from '../src/minute-facts-derive.js';

function job(id, attempts = 1) {
  return {
    id,
    attempts,
    payload_version: 1,
    payload_json: JSON.stringify({
      payload_version: 1,
      observedAt: 120_000 + id,
      snapshot: { channel_id: 10 },
      queue: null,
      comments: {},
    }),
  };
}

test('derive config applies bounded defaults', () => {
  assert.deepEqual(deriveConfig({}), {
    maxJobs: 8,
    jobTimeoutMs: 18_000,
    leaseMs: 60_000,
    maxAttempts: 8,
    runBudgetMs: 50_000,
  });
  assert.equal(deriveConfig({ DERIVE_MAX_JOBS: 999 }).maxJobs, 999);
  assert.equal(deriveConfig({ DERIVE_MAX_JOBS: 9_999 }).maxJobs, 1_000);
  assert.equal(deriveConfig({ DERIVE_JOB_TIMEOUT_MS: 99_999 }).jobTimeoutMs, 20_000);
});

test('retry delay grows exponentially and is capped at one hour', () => {
  assert.equal(minuteFactRetryDelayMs(1), 60_000);
  assert.equal(minuteFactRetryDelayMs(2), 120_000);
  assert.equal(minuteFactRetryDelayMs(4), 480_000);
  assert.equal(minuteFactRetryDelayMs(99), 3_600_000);
});

test('derive cron claims the batch once, then writes and completes each job', async () => {
  const calls = [];
  const result = await runMinuteFactDeriveCron(
    { MINUTE_DB: {} },
    {
      now: () => 1_000,
      claim: async (_env, options) => {
        calls.push(['claim', options.limit, options.leaseMs]);
        return calls.length === 1 ? [job(1), job(2)] : [];
      },
      write: async (env, payload) => {
        calls.push(['write', env.MINUTE_FACT_TIMEOUT_MS, payload.observedAt]);
      },
      complete: async (_env, id) => {
        calls.push(['complete', id]);
      },
      fail: async () => {
        throw new Error('unexpected fail');
      },
      release: async () => {
        throw new Error('unexpected release');
      },
      stats: async () => ({ pending_count: 0, processing_count: 0, dead_count: 0 }),
    },
  );

  assert.equal(result.processed, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls, [
    ['claim', 8, 60_000],
    ['write', 18_000, 120_001],
    ['complete', 1],
    ['write', 18_000, 120_002],
    ['complete', 2],
    ['claim', 6, 60_000],
  ]);
});

test('derive cron drains up to 1000 jobs through bounded 20-job claims', async () => {
  const pending = Array.from({ length: 1_000 }, (_, index) => job(index + 1));
  const claimSizes = [];
  const completed = [];
  const result = await runMinuteFactDeriveCron(
    { MINUTE_DB: {}, DERIVE_MAX_JOBS: 1_000 },
    {
      now: () => 1_000,
      claim: async (_env, options) => {
        claimSizes.push(options.limit);
        return pending.splice(0, options.limit);
      },
      write: async () => {},
      complete: async (_env, id) => { completed.push(id); },
      fail: async () => { throw new Error('unexpected fail'); },
      release: async () => { throw new Error('unexpected release'); },
      stats: async () => ({ pending_count: pending.length, processing_count: 0, dead_count: 0 }),
    },
  );

  assert.equal(result.processed, 1_000);
  assert.equal(completed.length, 1_000);
  assert.equal(claimSizes.length, 50);
  assert.ok(claimSizes.every((size) => size === 20));
});

test('derive cron returns budget-stranded jobs to the queue', async () => {
  const released = [];
  let clock = 1_000;
  const result = await runMinuteFactDeriveCron(
    { MINUTE_DB: {}, DERIVE_RUN_BUDGET_MS: 5_000 },
    {
      now: () => clock,
      claim: async () => [job(1), job(2)],
      write: async () => { clock = 6_000; },
      complete: async () => {},
      fail: async () => { throw new Error('unexpected fail'); },
      release: async (_env, ids) => { released.push(...ids); return { released: ids.length }; },
      stats: async () => ({ pending_count: 1, processing_count: 0, dead_count: 0 }),
    },
  );

  assert.equal(result.processed, 1);
  assert.equal(result.skipped_budget, 1);
  assert.deepEqual(released, [2]);
});

test('derive cron reschedules failed jobs without failing the cron event', async () => {
  const pending = [job(9, 3)];
  const failures = [];
  const result = await runMinuteFactDeriveCron(
    { MINUTE_DB: {}, DERIVE_MAX_JOBS: 1 },
    {
      now: () => 5_000,
      claim: async () => pending.length ? [pending.shift()] : [],
      write: async () => { throw new Error('D1 busy'); },
      complete: async () => { throw new Error('unexpected complete'); },
      fail: async (_env, receivedJob, error, options) => {
        failures.push({ receivedJob, error, options });
        return { terminal: false };
      },
      stats: async () => ({ pending_count: 1, processing_count: 0, dead_count: 0 }),
    },
  );

  assert.equal(result.processed, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.dead, 0);
  assert.equal(failures[0].receivedJob.id, 9);
  assert.match(failures[0].error.message, /D1 busy/);
  assert.equal(failures[0].options.retryDelayMs, 240_000);
});
