import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureMinuteFactRuntimeStateSchema,
  minuteFactRuntimeSignals,
  recordMinuteFactRuntimeState,
  resetMinuteFactRuntimeStateForTests,
} from '../src/minute-facts-runtime-state.js';

function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, values: null };
      calls.push(call);
      return {
        bind(...values) { call.values = values; return this; },
        async run() { return { meta: { changes: 1 } }; },
        async first() { return null; },
        async all() { return { results: [] }; },
      };
    },
  };
}

test('runtime state creates its own persistent table once', async () => {
  resetMinuteFactRuntimeStateForTests();
  const db = fakeDb();
  assert.equal(await ensureMinuteFactRuntimeStateSchema({ MINUTE_DB: db }), true);
  assert.equal(await ensureMinuteFactRuntimeStateSchema({ MINUTE_DB: db }), false);
  assert.match(db.calls[0].sql, /CREATE TABLE IF NOT EXISTS sh_minute_fact_runtime_state/);
});

test('runtime state records success counters and inbox health', async () => {
  resetMinuteFactRuntimeStateForTests();
  const db = fakeDb();
  const state = await recordMinuteFactRuntimeState({ MINUTE_DB: db }, 'derive', {
    processed: 3, failed: 1, pending_count: 4, processing_count: 2, dead_count: 1, oldest_pending_minute: 60_000,
  }, { now: 100_000, startedAt: 98_500 });
  assert.deepEqual(state, {
    task_name: 'derive', ok: true, at: 100_000, processed_count: 3, failed_count: 1,
    pending_count: 4, processing_count: 2, dead_count: 1, oldest_pending_minute: 60_000, error: null,
  });
  const values = db.calls.at(-1).values;
  assert.equal(values[2], 100_000);
  assert.equal(values[4], 1_500);
  assert.equal(values[9], 3);
  assert.equal(values[10], 1);
  assert.match(db.calls.at(-1).sql, /runs_total=sh_minute_fact_runtime_state.runs_total\+1/);
});

test('runtime state records sanitized task failures and exposes backlog signals', async () => {
  resetMinuteFactRuntimeStateForTests();
  const db = fakeDb();
  const state = await recordMinuteFactRuntimeState({ MINUTE_DB: db }, 'legacy', { error: new Error('token=secret failed'), dead_count: 2 }, { now: 100 });
  assert.equal(state.ok, false);
  assert.equal(state.error, 'token=secret failed');
  const values = db.calls.at(-1).values;
  assert.equal(values[3], 100);
  assert.equal(values[6], 1);
  assert.equal(values[8], 1);
  assert.deepEqual(minuteFactRuntimeSignals({
    dead_count: 1, pending_count: 2, oldest_pending_minute: 1_000, last_failure_at: 5_000, last_success_at: 4_000,
  }, { now: 20_000, pendingAgeMs: 10_000 }), {
    has_dead_jobs: true, pending_backlog: true, pending_stale: true, last_run_failed: true,
  });
});

test('runtime state rejects unsafe task names', async () => {
  resetMinuteFactRuntimeStateForTests();
  await assert.rejects(recordMinuteFactRuntimeState({ MINUTE_DB: fakeDb() }, 'derive;drop', {}), /task name is invalid/);
});

test('runtime signals never report stale backlog when the pending count is zero', () => {
  assert.deepEqual(minuteFactRuntimeSignals({
    pending_count: 0,
    oldest_pending_minute: 0,
    dead_count: 0,
    last_failure_at: 0,
    last_success_at: 1,
  }, { now: 1_000_000, pendingAgeMs: 60_000 }), {
    has_dead_jobs: false,
    pending_backlog: false,
    pending_stale: false,
    last_run_failed: false,
  });
});
