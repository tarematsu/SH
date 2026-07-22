import assert from 'node:assert/strict';
import test from 'node:test';

import { processBudgetedLiveTriggerMessage } from '../src/minute-live-trigger-budget-entry.js';
import {
  claimBudgetedLiveDeriveJob,
  releaseBudgetedLiveDeriveJob,
} from '../src/minute-live-trigger-lease.js';

function trigger(jobKind = 'live') {
  return {
    message_type: 'minute-fact-derive',
    message_version: 1,
    job_id: 'minute-fact:42:1700000000000',
    channel_id: 42,
    minute_at: 1_700_000_000_000,
    job_kind: jobKind,
  };
}

test('lightweight claim requires matching live job kind', async () => {
  const calls = [];
  const statement = {
    bind(...values) { calls.push(['bind', values]); return this; },
    async all() {
      calls.push(['all']);
      return { results: [{ id: 9, job_kind: 'live' }] };
    },
  };
  const job = await claimBudgetedLiveDeriveJob({
    MINUTE_DB: {
      prepare(sql) { calls.push(['sql', sql]); return statement; },
    },
  }, trigger(), { now: 500, leaseMs: 60_000 });

  assert.equal(job.id, 9);
  assert.match(calls[0][1], /AND job_kind=\?/);
  assert.deepEqual(calls[1], ['bind', [60_500, 500, 42, 1_700_000_000_000, 'live', 500, 500]]);
  assert.deepEqual(calls[2], ['all']);
});

test('lightweight release restores one claimed job without importing the inbox graph', async () => {
  const calls = [];
  const statement = {
    bind(...values) { calls.push(['bind', values]); return this; },
    async run() { calls.push(['run']); return { meta: { changes: 1 } }; },
  };
  const result = await releaseBudgetedLiveDeriveJob({
    MINUTE_DB: {
      prepare(sql) { calls.push(['sql', sql]); return statement; },
    },
  }, 9, { now: 700 });
  assert.deepEqual(result, { released: 1 });
  assert.match(calls[0][1], /attempts=MAX\(0,attempts-1\)/);
  assert.deepEqual(calls[1], ['bind', [700, 9]]);
});

test('budget trigger rejects rebuild input before claiming', async () => {
  let claims = 0;
  await assert.rejects(
    processBudgetedLiveTriggerMessage({}, trigger('rebuild'), {
      async claim() { claims += 1; },
    }),
    /invalid minute live derive trigger job kind/,
  );
  assert.equal(claims, 0);
});

test('failed stage enqueue releases the claimed job through the compatible batch boundary', async () => {
  const releases = [];
  await assert.rejects(
    processBudgetedLiveTriggerMessage({}, trigger(), {
      now: () => 900,
      async claim() {
        return {
          id: 9,
          channel_id: 42,
          minute_at: 1_700_000_000_000,
          payload_version: 1,
          job_kind: 'live',
          attempts: 1,
        };
      },
      async sendStage() { throw new Error('Queue unavailable'); },
      async release(_env, jobIds, options) { releases.push([jobIds, options]); },
    }),
    /Queue unavailable/,
  );
  assert.deepEqual(releases, [[[9], { now: 900 }]]);
});
