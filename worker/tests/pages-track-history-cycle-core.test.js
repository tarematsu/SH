import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTrackHistoryCycleStage,
  runTrackHistoryCycleStep,
  splitTrackHistoryRange,
  TRACK_HISTORY_CYCLE_MS,
  TRACK_HISTORY_STAGE_KEY,
} from '../src/pages-track-history-cycle.js';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const EPOCH = Date.UTC(2024, 4, 1);
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
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
  const stage = createTrackHistoryCycleStage(BASE, null, {});
  assert.equal(stage.generation, BASE);
  assert.equal(stage.refresh_mode, 'full');
  assert.equal(stage.tasks.filter(({ kind }) => kind === 'recent').length, 36);
  assert.equal(stage.tasks.filter(({ kind }) => kind === 'backfill').length, 7);
  assert.equal(stage.tasks.length + 1 <= 57, true, '43 shards plus one publication must fit');
});

test('same-day stage refreshes four recent days when backfill is complete', () => {
  const initial = incrementalState();
  const stage = createTrackHistoryCycleStage(
    BASE,
    initial[BACKFILL_KEY],
    initial[STATUS_KEY],
  );
  assert.equal(stage.refresh_mode, 'incremental');
  assert.equal(stage.tasks.length, 4);
  assert.equal(stage.tasks.every(({ kind }) => kind === 'recent'), true);
});

test('unfinished stage is adopted by the next cycle and publishes once', async () => {
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

  const first = await runTrackHistoryCycleStep(env, BASE + MINUTE_MS, dependencies);
  assert.equal(first.task.generation, BASE);
  assert.equal(first.completed, 1);
  await runTrackHistoryCycleStep(env, BASE + 2 * MINUTE_MS, dependencies);

  const nextCycle = BASE + TRACK_HISTORY_CYCLE_MS;
  const third = await runTrackHistoryCycleStep(env, nextCycle + MINUTE_MS, dependencies);
  const fourth = await runTrackHistoryCycleStep(env, nextCycle + 2 * MINUTE_MS, dependencies);
  assert.equal(third.task.generation, nextCycle);
  assert.equal(fourth.completed, 4);
  assert.equal(published.length, 0);

  const publication = await runTrackHistoryCycleStep(env, nextCycle + 3 * MINUTE_MS, dependencies);
  assert.equal(publication.task.kind, 'track-history-publish');
  assert.equal(publication.task.generation, nextCycle);
  assert.equal(publication.failed, 0);
  assert.equal(published.length, 1);
  assert.equal(refreshed.length, 4);
  assert.equal(memory.state.get(TRACK_HISTORY_STAGE_KEY).published, true);
  assert.equal(memory.state.get(TRACK_HISTORY_STAGE_KEY).generation, nextCycle);
  assert.equal(memory.state.get(STATUS_KEY).row_count, 99);
  assert.equal(memory.state.get(BACKFILL_KEY).completed, true);

  const sameCycle = await runTrackHistoryCycleStep(env, nextCycle + 4 * MINUTE_MS, dependencies);
  assert.equal(sameCycle.skipped, true);
  assert.equal(sameCycle.reason, 'track-history-cycle-already-published');
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
    await runTrackHistoryCycleStep(env, BASE + minute * MINUTE_MS, dependencies);
  }
  const failed = await runTrackHistoryCycleStep(env, BASE + 5 * MINUTE_MS, dependencies);
  assert.equal(failed.failed, 1);
  assert.equal(memory.state.get(TRACK_HISTORY_STAGE_KEY).published, false);

  const retried = await runTrackHistoryCycleStep(env, BASE + 6 * MINUTE_MS, dependencies);
  assert.equal(retried.failed, 0);
  assert.equal(memory.state.get(TRACK_HISTORY_STAGE_KEY).published, true);
  assert.equal(refreshCalls, 4);
  assert.equal(publishCalls, 2);
});
