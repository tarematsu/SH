import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAGES_READ_MODEL_CYCLE_MINUTES,
  TRACK_HISTORY_WINDOW_MINUTES,
  pagesSixHourTask,
  runPagesSixHourTask,
} from '../src/pages-six-hour-read-model.js';
import {
  TRACK_HISTORY_ACTIVE_MINUTES,
  runTrackHistoryCycleStep,
} from '../src/pages-track-history-cycle.js';

const MINUTE_MS = 60_000;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

class FakeStatement {
  constructor(sql) { this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  async run() { return { success: true }; }
}

class FakeDb {
  constructor() { this.batches = []; }
  prepare(sql) { return new FakeStatement(sql); }
  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true }));
  }
}

test('six-hour Pages work reserves only canonical history variants', () => {
  const reserved = [];
  const trackSteps = [];
  const idle = [];
  for (let minute = 0; minute < PAGES_READ_MODEL_CYCLE_MINUTES; minute += 1) {
    const task = pagesSixHourTask(BASE + minute * MINUTE_MS);
    if (task.kind === 'track-history-step') trackSteps.push(minute);
    else if (task.kind === 'idle') idle.push(minute);
    else reserved.push([minute, task.kind, task.key]);
  }

  assert.deepEqual(reserved, [
    [35, 'variant', 'history:daily'],
    [50, 'variant', 'host-history:summary'],
    [70, 'variant', 'history:weekly'],
    [105, 'variant', 'history:monthly'],
    [140, 'variant', 'history:broadcasts'],
  ]);
  assert.equal(TRACK_HISTORY_WINDOW_MINUTES, 175);
  assert.equal(TRACK_HISTORY_ACTIVE_MINUTES, 60);
  assert.equal(trackSteps.length, 170);
  assert.equal(idle.length, 185);
  assert.equal(trackSteps.includes(0), true);
  assert.equal(idle.includes(175), true);
  assert.equal(idle.includes(359), true);

  assert.deepEqual(
    pagesSixHourTask(BASE + 6 * 60 * MINUTE_MS + 50 * MINUTE_MS),
    {
      kind: 'track-history-step',
      key: 'track-history-stage',
      cycle_minute: 50,
      cycle_start: BASE + 6 * 60 * MINUTE_MS,
    },
  );
});

test('canonical history variant renders and persists one response', async () => {
  const db = new FakeDb();
  const env = { BUDDIES_DB: {}, MINUTE_DB: db, OTHER_DB: {} };
  const calls = [];
  const result = await runPagesSixHourTask(env, BASE + 35 * MINUTE_MS, {
    render: async (variant) => {
      calls.push(variant.key);
      return Response.json({ ok: true, rows: [] });
    },
    saveResponse: async (_db, _kv, key) => {
      calls.push(`save:${key}`);
      return { bytes: 20, chunks: 1 };
    },
  });

  assert.deepEqual(result.responses.map(({ key }) => key), ['history:daily']);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls, ['history:daily', 'save:history:daily']);
});

test('unreserved cycle minutes become track-history or idle work', () => {
  const expectedKinds = new Map([
    [0, 'track-history-step'],
    [175, 'idle'],
    [210, 'idle'],
    [245, 'idle'],
    [246, 'idle'],
  ]);
  for (const [minute, expectedKind] of expectedKinds) {
    const task = pagesSixHourTask(BASE + minute * MINUTE_MS);
    assert.equal(task.kind, expectedKind, `${minute}:${task.kind}`);
  }
});

test('idle cycle minutes do not inspect bindings or touch D1', async () => {
  const env = new Proxy({}, {
    get() { assert.fail('idle task must not inspect the environment'); },
  });
  const result = await runPagesSixHourTask(env, BASE + 300 * MINUTE_MS);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'six-hour-cycle-idle');
  assert.equal(result.task.kind, 'idle');
});

test('active track-history minute delegates exactly one shard step', async () => {
  const env = { BUDDIES_DB: {}, MINUTE_DB: {}, OTHER_DB: {} };
  const calls = [];
  const result = await runPagesSixHourTask(env, BASE + 45 * MINUTE_MS, {
    runTrackHistoryStep: async (_env, now) => {
      calls.push(now);
      return {
        skipped: false,
        generated_at: now,
        task: { kind: 'track-history-shard', key: 'recent:0:2025-12-29' },
        responses: [],
        failed: 0,
      };
    },
  });

  assert.equal(result.task.kind, 'track-history-shard');
  assert.deepEqual(calls, [BASE + 45 * MINUTE_MS]);
});

test('legacy track-history cycle rejects work outside its first hour before reading env', async () => {
  const env = new Proxy({}, {
    get() { assert.fail('inactive track-history minute must not inspect the environment'); },
  });
  const result = await runTrackHistoryCycleStep(env, BASE + 90 * MINUTE_MS);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'track-history-cycle-idle');
  assert.equal(result.task.cycle_minute, 90);
});
