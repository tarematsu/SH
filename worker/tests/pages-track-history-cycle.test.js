import assert from 'node:assert/strict';
import test from 'node:test';

import { runTrackHistoryCycleStep } from '../src/pages-track-history-cycle.js';
import { createTrackHistoryHourlyStage } from '../src/pages-track-history-hourly.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const CYCLE_MS = 6 * HOUR_MS;
const EPOCH = Date.UTC(2024, 4, 1);
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STAGE_KEY = 'track-history-hourly-stage';
const BACKFILL_KEY = 'track-history-backfill';
const STATUS_KEY = 'track-history-status';

function dayText(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
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

function initialState() {
  const backfill = { next_to: EPOCH, completed: true, updated_at: BASE - HOUR_MS };
  const status = {
    full_reconciled_at: Date.UTC(2026, 0, 1, 0, 5),
    generated_at: BASE - HOUR_MS,
    source_row_count: 321,
    source_row_count_refreshed_at: Date.UTC(2026, 0, 1, 0, 5),
    excluded_play_count_dates: [],
  };
  const stage = createTrackHistoryHourlyStage(BASE - HOUR_MS, backfill, status);
  assert.equal(stage.tasks.length, 4);
  stage.completed = Object.fromEntries(stage.tasks.slice(0, 3).map((task) => [
    task.id,
    shardResult(task.range),
  ]));
  return {
    [STAGE_KEY]: stage,
    [BACKFILL_KEY]: backfill,
    [STATUS_KEY]: status,
  };
}

function memoryDependencies(initial) {
  const state = new Map(Object.entries(initial));
  return {
    state,
    loadPayload: async (_db, key) => {
      const value = state.get(key);
      return value == null ? null : structuredClone(value);
    },
    savePayload: async (_db, key, value) => {
      state.set(key, structuredClone(value));
    },
  };
}

test('a carried hourly stage can publish only once in the current six-hour cycle', async () => {
  const memory = memoryDependencies(initialState());
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
      return {
        responses: [{ key: 'track-history', ok: true }],
        succeeded: 1,
        failed: 0,
      };
    },
  };

  const finalShard = await runTrackHistoryCycleStep(env, BASE + MINUTE_MS, dependencies);
  assert.equal(finalShard.completed, 4);
  assert.equal(refreshCalls, 1);

  const publication = await runTrackHistoryCycleStep(env, BASE + 2 * MINUTE_MS, dependencies);
  assert.equal(publication.task.kind, 'track-history-publish');
  assert.equal(publication.failed, 0);
  assert.equal(publishCalls, 1);

  const sameCycle = await runTrackHistoryCycleStep(env, BASE + 3 * MINUTE_MS, dependencies);
  assert.equal(sameCycle.skipped, true);
  assert.equal(sameCycle.reason, 'track-history-hour-already-published');
  assert.equal(refreshCalls, 1, 'must not start a second stage after carryover publication');
  assert.equal(publishCalls, 1);
  assert.equal(memory.state.get(STAGE_KEY).published, true);
  assert.equal(memory.state.get(STAGE_KEY).generation, BASE - HOUR_MS,
    'the persisted in-flight generation remains unchanged');

  const nextCycle = await runTrackHistoryCycleStep(
    env,
    BASE + CYCLE_MS + MINUTE_MS,
    dependencies,
  );
  assert.equal(nextCycle.task.kind, 'track-history-shard');
  assert.equal(refreshCalls, 2, 'the next six-hour cycle may create the next stage');
});
