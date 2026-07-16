import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MATERIALIZED_API_VARIANTS,
  materializedResponseMaximumAge,
} from '../../site/functions/lib/api-contract.js';
import {
  dueFastMaterializedVariants,
  materializedVariantDue,
  pagesPayloadRefreshPlan,
  trackHistoryRefreshRanges,
} from '../src/pages-read-model-refresh.js';

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2024, 4, 1);

test('track history always refreshes the recent window and starts bounded backfill behind it', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const ranges = trackHistoryRefreshRanges(now);
  const currentDay = Date.UTC(2026, 6, 16);

  assert.deepEqual(ranges.recent, {
    fromTs: currentDay - 35 * DAY_MS,
    toTs: currentDay + DAY_MS,
  });
  assert.deepEqual(ranges.backfill, {
    fromTs: currentDay - 42 * DAY_MS,
    toTs: currentDay - 35 * DAY_MS,
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

test('track history backfill clamps its final window to the archive epoch', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const ranges = trackHistoryRefreshRanges(now, { next_to: EPOCH + 3 * DAY_MS });

  assert.deepEqual(ranges.backfill, {
    fromTs: EPOCH,
    toTs: EPOCH + 3 * DAY_MS,
  });
  assert.equal(trackHistoryRefreshRanges(now, { next_to: EPOCH }).backfill, null);
});

test('materialized payloads follow their source cadence', () => {
  const midnight = Date.UTC(2026, 6, 16, 0, 0);
  const fivePast = Date.UTC(2026, 6, 16, 0, 5);
  const quarterPast = Date.UTC(2026, 6, 16, 0, 15);
  const halfPast = Date.UTC(2026, 6, 16, 0, 30);
  const materialized = new Map(MATERIALIZED_API_VARIANTS.map((variant) => [variant.key, variant]));

  assert.equal(materialized.get('host-history:summary').cadence_minutes, 1440);
  assert.equal(materialized.get('track-likes').cadence_minutes, 30);
  assert.equal(materialized.get('like-ranking').cadence_minutes, 30);
  assert.equal(materialized.get('track-history').cadence_minutes, 60);
  assert.equal(materializedVariantDue(materialized.get('host-history:summary'), midnight), true);
  assert.equal(materializedVariantDue(materialized.get('host-history:summary'), quarterPast), false);
  assert.equal(materializedVariantDue(materialized.get('track-likes'), halfPast), true);
  assert.equal(materializedVariantDue(materialized.get('track-likes'), quarterPast), false);
  assert.equal(materializedVariantDue(materialized.get('track-history'), midnight), true);
  assert.equal(materializedVariantDue(materialized.get('track-history'), quarterPast), false);
  assert.deepEqual(pagesPayloadRefreshPlan(fivePast), { daily: false, likes: false });
  assert.deepEqual(pagesPayloadRefreshPlan(quarterPast), { daily: true, likes: false });
  assert.deepEqual(pagesPayloadRefreshPlan(halfPast), { daily: true, likes: true });
});

test('track history maximum age covers the hourly source refresh plus edge grace', () => {
  assert.equal(
    materializedResponseMaximumAge('track-history', { PAGES_RESPONSE_MAX_AGE_MS: 15 * 60_000 }),
    65 * 60_000,
  );
});

test('quarter-hour fast refresh does not republish unchanged track history', () => {
  const keys = dueFastMaterializedVariants(Date.UTC(2026, 6, 16, 12, 15)).map(({ key }) => key);
  assert.equal(keys.includes('track-history'), false);
  assert.equal(keys.includes('minute-facts-current'), true);
});

test('half-hour fast refresh leaves track history to its hourly source refresh', () => {
  const keys = dueFastMaterializedVariants(Date.UTC(2026, 6, 16, 12, 30)).map(({ key }) => key);
  assert.equal(keys.includes('track-history'), false);
  assert.equal(keys.includes('track-likes'), true);
  assert.equal(keys.includes('like-ranking'), true);
  assert.equal(keys.includes('minute-facts-current'), true);
});
