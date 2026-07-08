import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAY_MS,
  JST_OFFSET_MS,
  jstDayKey,
  jstDayStartUtc,
  minuteBucket,
  previousJstDay,
  previousUtcDay,
  utcDayKey,
} from '../functions/lib/time-buckets.js';

test('minuteBucket floors timestamps to the minute', () => {
  assert.equal(minuteBucket(1_751_500_300_123), 1_751_500_280_000);
});

test('UTC and JST day keys keep timezone intent explicit', () => {
  const timestamp = Date.parse('2026-07-08T15:30:00Z');
  assert.equal(utcDayKey(timestamp), '2026-07-08');
  assert.equal(jstDayKey(timestamp), '2026-07-09');
});

test('JST day start is stored as the matching UTC timestamp', () => {
  const start = jstDayStartUtc('2026-07-09');
  assert.equal(start, Date.parse('2026-07-09T00:00:00Z') - JST_OFFSET_MS);
  assert.equal(new Date(start).toISOString(), '2026-07-08T15:00:00.000Z');
});

test('previous day helpers return bounded UTC ranges', () => {
  const now = Date.parse('2026-07-09T04:00:00Z');
  const utc = previousUtcDay(now);
  const jst = previousJstDay(now);

  assert.equal(utc.end - utc.start, DAY_MS);
  assert.equal(jst.end - jst.start, DAY_MS);
  assert.equal(utc.key, '2026-07-08');
  assert.equal(jst.key, '2026-07-08');
});
