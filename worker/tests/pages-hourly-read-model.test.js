import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pagesHourlyTask,
  runPagesHourlyTask,
} from '../src/pages-hourly-read-model.js';

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

test('hourly Pages work reserves API slots and uses every free minute for track history', () => {
  const reserved = [];
  const trackSteps = [];
  for (let minute = 0; minute < 60; minute += 1) {
    const task = pagesHourlyTask(BASE + minute * 60_000);
    if (task.kind === 'track-history-step') trackSteps.push(minute);
    else reserved.push([minute, task.kind, task.key]);
  }

  assert.deepEqual(reserved, [
    [0, 'variant', 'dashboard-history'],
    [5, 'variant', 'history:daily'],
    [10, 'variant', 'history:weekly'],
    [15, 'variant', 'history:monthly'],
    [20, 'variant', 'history:broadcasts'],
    [25, 'variant', 'minute-facts-current'],
    [30, 'variant', 'track-likes'],
    [35, 'source', 'source:like-ranking'],
    [40, 'variant', 'like-ranking'],
    [50, 'variant', 'host-history:summary'],
  ]);
  assert.equal(trackSteps.length, 50);
  assert.equal(trackSteps.includes(45), true);

  assert.deepEqual(
    pagesHourlyTask(BASE + 60 * 60_000 + 50 * 60_000),
    { kind: 'track-history-step', key: 'track-history-stage', minute: 50, hour: 1 },
  );
});

test('like-ranking source and response are separate minute tasks', async () => {
  const db = new FakeDb();
  const env = { BUDDIES_DB: {}, MINUTE_DB: db, OTHER_DB: {} };
  const calls = [];

  const source = await runPagesHourlyTask(env, BASE + 35 * 60_000, {
    ensureSchema: async () => calls.push('schema'),
    refreshLikeRanking: async (_db, now) => {
      calls.push(['source', now]);
      return { rows: 12 };
    },
    render: async () => assert.fail('source minute must not render a response'),
  });
  assert.equal(source.task.key, 'source:like-ranking');
  assert.deepEqual(source.source, { rows: 12 });

  const response = await runPagesHourlyTask(env, BASE + 40 * 60_000, {
    ensureSchema: async () => calls.push('schema'),
    payloadUpdatedAt: async () => BASE + 35 * 60_000,
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
    ['source', BASE + 35 * 60_000],
    'schema',
    ['render', 'like-ranking'],
  ]);
});

test('like-ranking publication refuses a source from the previous hour', async () => {
  const db = new FakeDb();
  const env = { BUDDIES_DB: {}, MINUTE_DB: db, OTHER_DB: {} };
  const result = await runPagesHourlyTask(env, BASE + 60 * 60_000 + 40 * 60_000, {
    ensureSchema: async () => {},
    payloadUpdatedAt: async () => BASE + 35 * 60_000,
    render: async () => assert.fail('stale source must not be published'),
  });

  assert.equal(result.failed, 1);
  assert.deepEqual(result.responses, [{
    key: 'like-ranking',
    ok: false,
    error: 'like-ranking source was not refreshed in the current hour',
  }]);
  assert.equal(db.batches.length, 0);
});

test('free minute delegates exactly one track history step', async () => {
  const env = { BUDDIES_DB: {}, MINUTE_DB: {}, OTHER_DB: {} };
  const calls = [];
  const result = await runPagesHourlyTask(env, BASE + 45 * 60_000, {
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
  assert.deepEqual(calls, [BASE + 45 * 60_000]);
});
