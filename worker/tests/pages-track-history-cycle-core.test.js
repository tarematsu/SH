import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTrackHistoryCycleStage,
  runTrackHistoryCycleStep,
  splitTrackHistoryRange,
  TRACK_HISTORY_STAGE_KEY,
} from '../src/pages-track-history-cycle.js';
import { mergeTrackHistoryExcludedDates } from '../src/pages-track-history-support.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 60 * 60_000;
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

test('track history ranges split into six-hour CPU shards', () => {
  const fromTs = Date.UTC(2026, 0, 1);
  assert.deepEqual(splitTrackHistoryRange({ fromTs, toTs: fromTs + DAY_MS }), [
    { fromTs, toTs: fromTs + 6 * HOUR_MS },
    { fromTs: fromTs + 6 * HOUR_MS, toTs: fromTs + 12 * HOUR_MS },
    { fromTs: fromTs + 12 * HOUR_MS, toTs: fromTs + 18 * HOUR_MS },
    { fromTs: fromTs + 18 * HOUR_MS, toTs: fromTs + DAY_MS },
  ]);
  assert.deepEqual(splitTrackHistoryRange(null), []);
});

test('sub-day exclusion refresh replaces only the active UTC day', () => {
  const fromTs = Date.UTC(2026, 0, 1, 6);
  assert.deepEqual(mergeTrackHistoryExcludedDates(
    ['2025-12-31', '2026-01-01', '2026-01-02'],
    [],
    { fromTs, toTs: fromTs + 6 * HOUR_MS },
  ), ['2025-12-31', '2026-01-02']);
});

test('monthly full reconciliation and bounded backfill fit inside the recovery window', () => {
  const stage = createTrackHistoryCycleStage(BASE, null, {});
  assert.equal(stage.generation, BASE);
  assert.equal(stage.refresh_mode, 'full');
  assert.equal(stage.tasks.filter(({ kind }) => kind === 'recent').length, 144);
  assert.equal(stage.tasks.filter(({ kind }) => kind === 'backfill').length, 4);
  assert.equal(stage.tasks.length + 1 <= 175, true, '148 shards plus publication dispatch must fit');
});

test('same-month stage refreshes eight recent shards when backfill is complete', () => {
  const initial = incrementalState();
  const stage = createTrackHistoryCycleStage(
    BASE,
    initial[BACKFILL_KEY],
    initial[STATUS_KEY],
  );
  assert.equal(stage.refresh_mode, 'incremental');
  assert.equal(stage.tasks.length, 8);
  assert.equal(stage.tasks.every(({ kind }) => kind === 'recent'), true);
  assert.deepEqual(
    stage.tasks.map(({ cleanup_day: cleanupDay }) => cleanupDay),
    [false, false, false, true, false, false, false, true],
  );
});

test('cycle core processes shards and cleans each day only after its final shard', async () => {
  const memory = memoryDependencies(incrementalState());
  const env = { BUDDIES_DB: {}, MINUTE_DB: {} };
  const refreshed = [];
  const dependencies = {
    ...memory,
    refreshDay: async (_sourceDb, _targetDb, range, _timestamp, options) => {
      refreshed.push({ range, options });
      return shardResult(range);
    },
  };

  let result;
  for (let minute = 1; minute <= 8; minute += 1) {
    result = await runTrackHistoryCycleStep(env, BASE + minute * MINUTE_MS, dependencies);
    assert.equal(result.completed, minute);
  }
  const ready = await runTrackHistoryCycleStep(env, BASE + 9 * MINUTE_MS, dependencies);

  assert.equal(ready.skipped, true);
  assert.equal(ready.reason, 'track-history-shards-complete');
  assert.equal(ready.task.kind, 'track-history-publish-ready');
  assert.equal(refreshed.length, 8);
  assert.deepEqual(
    refreshed.map(({ options }) => options.cleanupDay),
    [false, false, false, true, false, false, false, true],
  );
  assert.equal(refreshed.every(({ options }) => options.generation === BASE), true);
  assert.equal(memory.state.get(TRACK_HISTORY_STAGE_KEY).published, false);
  assert.equal(memory.state.has(STATUS_KEY), true);
  assert.equal(result.completed, 8);
});
