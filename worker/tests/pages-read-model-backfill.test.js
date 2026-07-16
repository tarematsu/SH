import assert from 'node:assert/strict';
import test from 'node:test';

import { trackHistoryRefreshRanges } from '../src/pages-read-model-refresh.js';

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
