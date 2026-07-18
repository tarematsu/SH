import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { deriveConfig } from '../worker/src/minute-facts-derive.js';
import { streamGoalPredictionIntervalMs } from '../worker/src/stream-goal-prediction.js';
import { trackHistoryRefreshRanges } from '../worker/src/pages-track-history-support.js';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const DAY_MS = 86_400_000;

test('public health uses a primary-key high-water mark instead of a full fact count', () => {
  const text = source('../site/functions/api/health.js');
  assert.match(text, /COALESCE\(MAX\(id\),0\) AS count FROM sh_minute_facts/);
  assert.doesNotMatch(text, /COUNT\(\*\) AS count FROM sh_minute_facts/);
});

test('stream-goal prediction defaults to a six-hour budget', () => {
  assert.equal(streamGoalPredictionIntervalMs({}), 6 * 60 * 60_000);
  assert.equal(streamGoalPredictionIntervalMs({ STREAM_GOAL_PREDICTION_INTERVAL_MS: 1_800_000 }), 1_800_000);
  const entry = source('../worker/src/stream-goal-prediction.js');
  const config = source('../worker/wrangler.other.jsonc');
  assert.match(entry, /PREDICTION_WINDOW_MS = 6 \* 60 \* 60_000/);
  assert.match(config, /"STREAM_GOAL_PREDICTION_INTERVAL_MS"\s*:\s*21600000/);
});

test('track-history refresh scans one recent and one backfill day per cycle', () => {
  const now = Date.UTC(2026, 6, 19, 12);
  const currentDay = Math.floor(now / DAY_MS) * DAY_MS;
  const previousFullAt = currentDay - 2 * DAY_MS;
  const ranges = trackHistoryRefreshRanges(
    now,
    { next_to: currentDay - 35 * DAY_MS },
    { full_reconciled_at: previousFullAt },
  );
  assert.equal(ranges.fullReconcile, false);
  assert.equal(ranges.recent.fromTs, currentDay - DAY_MS);
  assert.equal(ranges.recent.toTs, currentDay + DAY_MS);
  assert.equal(ranges.backfill.toTs - ranges.backfill.fromTs, DAY_MS);

  const monthly = trackHistoryRefreshRanges(
    now,
    { next_to: currentDay - 35 * DAY_MS },
    { full_reconciled_at: currentDay - 31 * DAY_MS },
  );
  assert.equal(monthly.fullReconcile, true);
  assert.equal(monthly.recent.fromTs, currentDay - 35 * DAY_MS);
});

test('minute derive samples full inbox statistics hourly by default', () => {
  assert.equal(deriveConfig({}).statsIntervalMs, 60 * 60_000);
  const text = source('../worker/src/minute-facts-derive.js');
  assert.match(text, /startedAt % config\.statsIntervalMs < 60_000/);
  assert.match(text, /summary\.stats_skipped = true/);
});

test('facts provisioning updates only unrepaired revision rows', () => {
  const text = source('../worker/scripts/provision-facts-db.mjs');
  assert.match(text, /WHERE coverage_complete IS NOT CASE/);
  assert.match(text, /WHERE source_visible_count IS NULL/);
  assert.match(text, /019_d1_budget_indexes\.sql/);
  assert.doesNotMatch(text, /SET source_visible_count=COALESCE\(source_visible_count,materialized_item_count,item_count\)`/);
});

test('live verification uses bounded facts and revision probes', () => {
  const text = source('../worker/scripts/verify-facts-live.mjs');
  assert.match(text, /COALESCE\(\(SELECT MAX\(id\) FROM sh_minute_facts\),0\) AS fact_count/);
  assert.match(text, /WITH recent_revisions AS/);
  assert.match(text, /ORDER BY r\.effective_at DESC,r\.id DESC\s+LIMIT 500/);
  assert.doesNotMatch(text, /COUNT\(\*\) AS fact_count,\s+MAX\(observed_at\)/);
});

test('D1 budget indexes stay selective', () => {
  const buddies = source('../database/buddies-migrations/007_d1_budget_indexes.sql');
  const facts = source('../database/facts-migrations/019_d1_budget_indexes.sql');
  assert.match(buddies, /sh_channel_snapshots\(observed_at, id\)/);
  assert.match(buddies, /sh_queue_items\(start_time, station_id\)/);
  assert.match(facts, /WHERE reported_current_stream_count IS NOT NULL/);
  assert.match(facts, /WHERE status='pending'/);
  assert.match(facts, /WHERE status='processing'/);
  assert.match(facts, /WHERE status='complete' AND source='live_collector'/);
});
