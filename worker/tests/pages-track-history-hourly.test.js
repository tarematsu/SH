import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTrackHistoryHourlyStage,
  runTrackHistoryHourlyStep,
  splitTrackHistoryRange,
} from '../src/pages-track-history-hourly.js';

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2024, 4, 1);
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STAGE_KEY = 'track-history-hourly-stage';
const BACKFILL_KEY = 'track-history-backfill';
const STATUS_KEY = 'track-history-status';

function dayText(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function memoryDependencies(initial = {}) {
  const state = new Map(Object.entries(initial));
  return {
    state,
    loadPayload: async (_db, key) => state.get(key) || null,
    savePayload: async (_db, key, payload) => {
      state.set(key, structuredClone(payload));
    },
  };
}

function incrementalState() {
  return {
    [BACKFILL_KEY]: { next_to: EPOCH, completed: true, updated_at: BASE },
    [STATUS_KEY]: {
      full_reconciled_at: Date.UTC(2026, 0, 1, 0, 5),
      generated_at: Date.UTC(2026, 0, 1, 11, 5),
      source_row_count: 321,
      source_row_count_refreshed_at: Date.UTC(2026, 0, 1, 0, 5),
      excluded_play_count_dates: ['2025-12-01'],
    },
  };
}

function shardResult(range) {
  return {
    from: dayText(range.fromTs),
    to: dayText(range.toTs - 1),
    rows: 1,
    groupedRows: 1,
    sourceRowCount: 2,
    excludedDates: [],
  };
}

test('track history ranges split into one-day shards', () => {
  const fromTs = Date.UTC(2026, 0, 1);
  assert.deepEqual(splitTrackHistoryRange({ fromTs, toTs: fromTs + 3 * DAY_MS }), [
    { fromTs, toTs: fromTs + DAY_MS },
    { fromTs: fromTs + DAY_MS, toTs: fromTs + 2 * DAY_MS },
    { fromTs: fromTs + 2 * DAY_MS, toTs: fromTs + 3 * DAY_MS },
  ]);
  assert.deepEqual(splitTrackHistoryRange(null), []);
});

test('full daily stage fits inside the first cycle hour free slots', () => {
  const stage = createTrackHistoryHourlyStage(BASE, null, {});
  assert.equal(stage.refresh_mode, 'full');
  assert.equal(stage.tasks.filter(({ kind }) => kind === 'recent').length, 36);
  assert.equal(stage.tasks.filter(({ kind }) => kind === 'backfill').length, 7);
  assert.equal(stage.tasks.length + 1 <= 57, true, '43 shards plus one publication must fit');
});

test('same-day stage refreshes four recent days when backfill is complete', () => {
  const initial = incrementalState();
  const stage = createTrackHistoryHourlyStage(
    BASE,
    initial[BACKFILL_KEY],
    initial[STATUS_KEY],
  );
  assert.equal(stage.refresh_mode, 'incremental');
  assert.equal(stage.tasks.length, 4);
  assert.equal(stage.tasks.every(({ kind }) => kind === 'recent'), true);
});

test('unfinished stage survives a boundary and publishes only after every shard', async () => {
  const memory = memoryDependencies(incrementalState());
  const env = { BUDDIES_DB: {}, MINUTE_DB: {} };
  const refreshed = [];
  const published = [];
  const dependencies = {
    ...memory,
    refreshDay: async (_sourceDb, _targetDb, range) => {
      refreshed.push(range);
      return shardResult(range);
    },
    coverage: async () => ({
      earliest_date: '2025-11-27',
      latest_date: '2026-01-01',
      recent_row_count: 99,
    }),
    publish: async (_env, now) => {
      published.push(now);
      return {
        responses: [{ key: 'track-history', ok: true }],
        succeeded: 1,
        failed: 0,
      };
    },
  };

  const first = await runTrackHistoryHourlyStep(env, BASE + 60_000, dependencies);
  const generation = first.task.generation;
  assert.equal(first.completed, 1);

  await runTrackHistoryHourlyStep(env, BASE + 2 * 60_000, dependencies);
  const third = await runTrackHistoryHourlyStep(env, BASE + 61 * 60_000, dependencies);
  const fourth = await runTrackHistoryHourlyStep(env, BASE + 62 * 60_000, dependencies);
  assert.equal(third.task.generation, generation);
  assert.equal(fourth.completed, 4);
  assert.equal(published.length, 0);

  const publication = await runTrackHistoryHourlyStep(env, BASE + 63 * 60_000, dependencies);
  assert.equal(publication.task.kind, 'track-history-publish');
  assert.equal(publication.task.generation, generation);
  assert.equal(publication.failed, 0);
  assert.equal(published.length, 1);
  assert.equal(refreshed.length, 4);
  assert.equal(memory.state.get(STAGE_KEY).published, true);
  assert.equal(memory.state.get(STATUS_KEY).row_count, 99);
  assert.equal(memory.state.get(BACKFILL_KEY).completed, true);
});

test('failed publication retries without repeating completed shards', async () => {
  const memory = memoryDependencies(incrementalState());
  const env = { BUDDIES_DB: {}, MINUTE_DB: {} };
  let refreshCalls = 0;
  let publishCalls = 0;
  const dependencies = {
    ...memory,
    refreshDay: async (_sourceDb, _targetDb, range) => {
      refreshCalls += 1;
      return shardResult(range);
    },
    coverage: async () => ({ recent_row_count: 4 }),
    publish: async () => {
      publishCalls += 1;
      return publishCalls === 1
        ? { responses: [{ key: 'track-history', ok: false, error: 'render failed' }], succeeded: 0, failed: 1 }
        : { responses: [{ key: 'track-history', ok: true }], succeeded: 1, failed: 0 };
    },
  };

  for (let minute = 1; minute <= 4; minute += 1) {
    await runTrackHistoryHourlyStep(env, BASE + minute * 60_000, dependencies);
  }
  const failed = await runTrackHistoryHourlyStep(env, BASE + 5 * 60_000, dependencies);
  assert.equal(failed.failed, 1);
  assert.equal(memory.state.get(STAGE_KEY).published, false);

  const retried = await runTrackHistoryHourlyStep(env, BASE + 6 * 60_000, dependencies);
  assert.equal(retried.failed, 0);
  assert.equal(memory.state.get(STAGE_KEY).published, true);
  assert.equal(refreshCalls, 4);
  assert.equal(publishCalls, 2);
});
