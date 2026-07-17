import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MATERIALIZED_API_VARIANTS,
  materializedResponseMaximumAge,
} from '../../site/functions/lib/api-contract.js';
import {
  dueFastMaterializedVariants,
  materializedVariantDue,
  mergeTrackHistoryExcludedDates,
  pagesPayloadRefreshPlan,
  trackHistoryRefreshRanges,
} from '../src/pages-read-model-refresh.js';

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2024, 4, 1);

test('missing status performs a full recent refresh and starts bounded backfill behind it', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const ranges = trackHistoryRefreshRanges(now);
  const currentDay = Date.UTC(2026, 6, 16);

  assert.equal(ranges.fullReconcile, true);
  assert.equal(ranges.previousFullAt, null);
  assert.deepEqual(ranges.recent, {
    fromTs: currentDay - 35 * DAY_MS,
    toTs: currentDay + DAY_MS,
  });
  assert.deepEqual(ranges.fullRecent, ranges.recent);
  assert.deepEqual(ranges.backfill, {
    fromTs: currentDay - 42 * DAY_MS,
    toTs: currentDay - 35 * DAY_MS,
  });
});

test('same-day status limits cycle refresh to the latest three days', () => {
  const now = Date.UTC(2026, 6, 16, 12, 31);
  const currentDay = Date.UTC(2026, 6, 16);
  const fullAt = Date.UTC(2026, 6, 16, 0, 31);
  const ranges = trackHistoryRefreshRanges(now, null, { full_reconciled_at: fullAt });

  assert.equal(ranges.fullReconcile, false);
  assert.equal(ranges.previousFullAt, fullAt);
  assert.deepEqual(ranges.recent, {
    fromTs: currentDay - 3 * DAY_MS,
    toTs: currentDay + DAY_MS,
  });
  assert.deepEqual(ranges.fullRecent, {
    fromTs: currentDay - 35 * DAY_MS,
    toTs: currentDay + DAY_MS,
  });
  assert.deepEqual(ranges.backfill, {
    fromTs: currentDay - 42 * DAY_MS,
    toTs: currentDay - 35 * DAY_MS,
  });
});

test('legacy generated_at is accepted as the previous full refresh', () => {
  const now = Date.UTC(2026, 6, 16, 12, 31);
  const generatedAt = Date.UTC(2026, 6, 16, 10, 31);
  const ranges = trackHistoryRefreshRanges(now, null, { generated_at: generatedAt });

  assert.equal(ranges.fullReconcile, false);
  assert.equal(ranges.previousFullAt, generatedAt);
});

test('the first cycle refresh after a UTC day change performs the full 35-day sweep', () => {
  const now = Date.UTC(2026, 6, 17, 0, 31);
  const currentDay = Date.UTC(2026, 6, 17);
  const ranges = trackHistoryRefreshRanges(now, null, {
    full_reconciled_at: Date.UTC(2026, 6, 16, 23, 31),
  });

  assert.equal(ranges.fullReconcile, true);
  assert.deepEqual(ranges.recent, {
    fromTs: currentDay - 35 * DAY_MS,
    toTs: currentDay + DAY_MS,
  });
});

test('track history backfill resumes from the durable cursor', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const nextTo = Date.UTC(2025, 0, 15);
  const ranges = trackHistoryRefreshRanges(now, { next_to: nextTo });

  assert.deepEqual(ranges.backfill, {
    fromTs: nextTo - 7 * DAY_MS,
    toTs: nextTo,
  });
});

test('incremental refresh does not move the backfill boundary forward to three days', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const currentDay = Date.UTC(2026, 6, 16);
  const ranges = trackHistoryRefreshRanges(now, null, { full_reconciled_at: now });

  assert.deepEqual(ranges.backfill, {
    fromTs: currentDay - 42 * DAY_MS,
    toTs: currentDay - 35 * DAY_MS,
  });
});

test('track history backfill clamps its final window to the archive epoch', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const ranges = trackHistoryRefreshRanges(now, { next_to: EPOCH + 3 * DAY_MS });

  assert.deepEqual(ranges.backfill, {
    fromTs: EPOCH,
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

test('materialized payloads declare six-hour cadence while legacy source repair keeps its cadence', () => {
  const midnight = Date.UTC(2026, 6, 16, 0, 0);
  const fivePast = Date.UTC(2026, 6, 16, 0, 5);
  const quarterPast = Date.UTC(2026, 6, 16, 0, 15);
  const halfPast = Date.UTC(2026, 6, 16, 0, 30);
  const sixHoursLater = Date.UTC(2026, 6, 16, 6, 0);
  const materialized = new Map(MATERIALIZED_API_VARIANTS.map((variant) => [variant.key, variant]));

  assert.equal(materialized.get('host-history:summary').cadence_minutes, 1440);
  for (const [key, variant] of materialized) {
    if (key !== 'host-history:summary') assert.equal(variant.cadence_minutes, 360, key);
  }
  assert.equal(materializedVariantDue(materialized.get('track-likes'), midnight), true);
  assert.equal(materializedVariantDue(materialized.get('track-likes'), halfPast), false);
  assert.equal(materializedVariantDue(materialized.get('track-likes'), sixHoursLater), true);
  assert.equal(materializedVariantDue(materialized.get('track-history'), midnight), true);
  assert.equal(materializedVariantDue(materialized.get('track-history'), quarterPast), false);
  assert.deepEqual(pagesPayloadRefreshPlan(fivePast), { daily: false, likes: false });
  assert.deepEqual(pagesPayloadRefreshPlan(quarterPast), { daily: true, likes: false });
  assert.deepEqual(pagesPayloadRefreshPlan(halfPast), { daily: true, likes: true });
});

test('track history maximum age covers the six-hour source refresh plus edge grace', () => {
  assert.equal(
    materializedResponseMaximumAge('track-history', { PAGES_RESPONSE_MAX_AGE_MS: 15 * 60_000 }),
    365 * 60_000,
  );
});

test('legacy fast refresh runs only at six-hour boundaries and never republishes track history', () => {
  const boundaryKeys = dueFastMaterializedVariants(Date.UTC(2026, 6, 16, 12, 0)).map(({ key }) => key);
  assert.equal(boundaryKeys.includes('track-history'), false);
  assert.equal(boundaryKeys.includes('minute-facts-current'), true);
  assert.equal(boundaryKeys.includes('track-likes'), true);
  assert.equal(boundaryKeys.includes('like-ranking'), true);

  for (const minute of [5, 15, 30, 45]) {
    assert.deepEqual(
      dueFastMaterializedVariants(Date.UTC(2026, 6, 16, 12, minute)).map(({ key }) => key),
      [],
    );
  }
  assert.deepEqual(
    dueFastMaterializedVariants(Date.UTC(2026, 6, 16, 13, 0)).map(({ key }) => key),
    [],
  );
});
