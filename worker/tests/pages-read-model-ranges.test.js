import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MATERIALIZED_API_VARIANTS,
  materializedResponseMaximumAge,
} from '../../site/functions/lib/api-contract.js';
import {
  mergeTrackHistoryExcludedDates,
  trackHistoryRefreshRanges,
} from '../src/pages-track-history-support.js';
import { pagesSixHourTask } from '../src/pages-six-hour-read-model.js';

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2024, 4, 1);

 test('missing status performs a full 35-day refresh and one-day bounded backfill', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const currentDay = Date.UTC(2026, 6, 16);
  const ranges = trackHistoryRefreshRanges(now);

  assert.equal(ranges.fullReconcile, true);
  assert.equal(ranges.previousFullAt, null);
  assert.deepEqual(ranges.recent, {
    fromTs: currentDay - 35 * DAY_MS,
    toTs: currentDay + DAY_MS,
  });
  assert.deepEqual(ranges.fullRecent, ranges.recent);
  assert.deepEqual(ranges.backfill, {
    fromTs: currentDay - 36 * DAY_MS,
    toTs: currentDay - 35 * DAY_MS,
  });
});

test('recent status limits incremental refresh to the latest day', () => {
  const now = Date.UTC(2026, 6, 16, 12, 31);
  const currentDay = Date.UTC(2026, 6, 16);
  const fullAt = Date.UTC(2026, 6, 15, 0, 31);
  const ranges = trackHistoryRefreshRanges(now, null, { full_reconciled_at: fullAt });

  assert.equal(ranges.fullReconcile, false);
  assert.equal(ranges.previousFullAt, fullAt);
  assert.deepEqual(ranges.recent, {
    fromTs: currentDay - DAY_MS,
    toTs: currentDay + DAY_MS,
  });
  assert.deepEqual(ranges.fullRecent, {
    fromTs: currentDay - 35 * DAY_MS,
    toTs: currentDay + DAY_MS,
  });
});

test('legacy generated_at is accepted as the previous full refresh', () => {
  const now = Date.UTC(2026, 6, 16, 12, 31);
  const generatedAt = Date.UTC(2026, 6, 10, 10, 31);
  const ranges = trackHistoryRefreshRanges(now, null, { generated_at: generatedAt });
  assert.equal(ranges.fullReconcile, false);
  assert.equal(ranges.previousFullAt, generatedAt);
});

test('full reconcile occurs when the previous full sweep is thirty days old', () => {
  const now = Date.UTC(2026, 6, 31, 12, 31);
  const ranges = trackHistoryRefreshRanges(now, null, {
    full_reconciled_at: Date.UTC(2026, 6, 1),
  });
  assert.equal(ranges.fullReconcile, true);
});

test('track history backfill resumes one day behind the durable cursor', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const nextTo = Date.UTC(2025, 0, 15);
  const ranges = trackHistoryRefreshRanges(now, { next_to: nextTo });
  assert.deepEqual(ranges.backfill, {
    fromTs: nextTo - DAY_MS,
    toTs: nextTo,
  });
});

test('track history backfill clamps its final window to the archive epoch', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const ranges = trackHistoryRefreshRanges(now, { next_to: EPOCH + 3 * DAY_MS });
  assert.deepEqual(ranges.backfill, {
    fromTs: EPOCH + 2 * DAY_MS,
    toTs: EPOCH + 3 * DAY_MS,
  });
  assert.equal(trackHistoryRefreshRanges(now, { next_to: EPOCH }).backfill, null);
});

test('incremental excluded-date updates replace only dates inside the refreshed range', () => {
  const range = {
    fromTs: Date.UTC(2026, 6, 13),
    toTs: Date.UTC(2026, 6, 17),
  };
  assert.deepEqual(
    mergeTrackHistoryExcludedDates(
      ['2026-06-01', '2026-07-13', '2026-07-15'],
      ['2026-07-14', '2026-07-15'],
      range,
    ),
    ['2026-06-01', '2026-07-14', '2026-07-15'],
  );
});

test('canonical materialized variants keep the intended publication cadence', () => {
  const materialized = new Map(MATERIALIZED_API_VARIANTS.map((variant) => [variant.key, variant]));
  assert.deepEqual([...materialized.keys()], [
    'history:daily',
    'history:weekly',
    'history:monthly',
    'history:broadcasts',
    'track-history',
    'host-history:summary',
  ]);
  assert.equal(materialized.get('track-history').cadence_minutes, 1440);
  assert.equal(materialized.get('host-history:summary').cadence_minutes, 1440);
  for (const [key, variant] of materialized) {
    if (key !== 'track-history' && key !== 'host-history:summary') {
      assert.equal(variant.cadence_minutes, 360, key);
    }
  }
});

test('track history maximum age covers daily source refresh plus edge grace', () => {
  assert.equal(
    materializedResponseMaximumAge('track-history', { PAGES_RESPONSE_MAX_AGE_MS: 15 * 60_000 }),
    1445 * 60_000,
  );
});

test('daily scheduler preserves six-hour variants while using the remaining day for track history', () => {
  const cycle = Date.UTC(2026, 6, 16, 0, 0);
  assert.equal(pagesSixHourTask(cycle).kind, 'track-history-step');
  assert.equal(pagesSixHourTask(cycle + 35 * 60_000).key, 'history:daily');
  assert.equal(pagesSixHourTask(cycle + 395 * 60_000).key, 'history:daily');
  assert.equal(pagesSixHourTask(cycle + 70 * 60_000).key, 'history:weekly');
  assert.equal(pagesSixHourTask(cycle + 105 * 60_000).key, 'history:monthly');
  assert.equal(pagesSixHourTask(cycle + 140 * 60_000).key, 'history:broadcasts');
  assert.equal(pagesSixHourTask(cycle + 410 * 60_000).kind, 'track-history-step');
  assert.equal(pagesSixHourTask(cycle + 1434 * 60_000).kind, 'track-history-step');
  assert.equal(pagesSixHourTask(cycle + 1435 * 60_000).kind, 'idle');
});
