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
  constructor(sql) {
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async run() {
    return { success: true };
  }
}

class FakeDb {
  constructor() {
    this.batches = [];
  }

  prepare(sql) {
    return new FakeStatement(sql);
  }

  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true }));
  }
}

test('six-hour Pages work distributes API tasks and leaves later minutes fully idle', () => {
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
    [0, 'variant', 'dashboard-history'],
    [35, 'variant', 'history:daily'],
    [50, 'variant', 'host-history:summary'],
    [70, 'variant', 'history:weekly'],
    [105, 'variant', 'history:monthly'],
    [140, 'variant', 'history:broadcasts'],
    [175, 'variant', 'minute-facts-current'],
    [210, 'variant', 'track-likes'],
    [245, 'source', 'source:like-ranking'],
    [246, 'variant', 'like-ranking'],
  ]);
  assert.equal(TRACK_HISTORY_WINDOW_MINUTES, 60);
  assert.equal(TRACK_HISTORY_ACTIVE_MINUTES, 60);
  assert.equal(trackSteps.length, 57);
  assert.equal(idle.length, 293);
  assert.equal(idle.includes(60), true);
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

test('like-ranking source and response are separate cycle-minute tasks', async () => {
  const db = new FakeDb();
  const env = { BUDDIES_DB: {}, MINUTE_DB: db, OTHER_DB: {} };
  const calls = [];

  const sourceAt = BASE + 245 * MINUTE_MS;
  const source = await runPagesSixHourTask(env, sourceAt, {
    ensureSchema: async () => calls.push('schema'),
    refreshLikeRanking: async (_db, now) => {
      calls.push(['source', now]);
      return { rows: 12 };
    },
    render: async () => assert.fail('source minute must not render a response'),
  });
  assert.equal(source.task.key, 'source:like-ranking');
  assert.deepEqual(source.source, { rows: 12 });

  const responseAt = BASE + 246 * MINUTE_MS;
  const response = await runPagesSixHourTask(env, responseAt, {
    ensureSchema: async () => calls.push('schema'),
    payloadUpdatedAt: async () => sourceAt,
    render: async (variant) => {
      calls.push(['render', variant.key]);
      return Response.json({ ok: true, rows: [] });
    },
  });
  assert.deepEqual(response.responses.map(({ key }) => key), ['like-ranking']);
  assert.equal(response.failed, 0);
  assert.equal(db.batches.length, 1);
  assert.deepEqual(calls, [
    'schema',
    ['source', sourceAt],
    'schema',
    ['render', 'like-ranking'],
  ]);
});

test('like-ranking publication refuses a source from the previous six-hour cycle', async () => {
  const db = new FakeDb();
  const env = { BUDDIES_DB: {}, MINUTE_DB: db, OTHER_DB: {} };
  const result = await runPagesSixHourTask(env, BASE + (6 * 60 + 246) * MINUTE_MS, {
    ensureSchema: async () => {},
    payloadUpdatedAt: async () => BASE + 245 * MINUTE_MS,
    render: async () => assert.fail('stale source must not be published'),
  });

  assert.equal(result.failed, 1);
  assert.deepEqual(result.responses, [{
    key: 'like-ranking',
    ok: false,
    error: 'like-ranking source was not refreshed in the current six-hour cycle',
  }]);
  assert.equal(db.batches.length, 0);
});

test('idle cycle minutes do not inspect bindings or touch D1', async () => {
  const env = new Proxy({}, {
    get() {
      assert.fail('idle task must not inspect the environment');
    },
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

test('track-history cycle wrapper rejects work outside the first hour before reading env', async () => {
  const env = new Proxy({}, {
    get() {
      assert.fail('inactive track-history minute must not inspect the environment');
    },
  });
  const result = await runTrackHistoryCycleStep(env, BASE + 90 * MINUTE_MS);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'track-history-cycle-idle');
  assert.equal(result.task.cycle_minute, 90);
});
