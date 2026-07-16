import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExpectedMinuteCandidates,
  nextGapScanCursor,
} from '../src/minute-facts-gap-scan.js';

const MINUTE_MS = 60_000;

function snapshot(minute, overrides = {}) {
  return {
    id: minute + 1,
    observed_at: minute * MINUTE_MS + 10_000,
    channel_id: 1,
    station_id: 10,
    is_broadcasting: 1,
    broadcast_start_time: 1_000,
    listener_count: 20 + minute,
    ...overrides,
  };
}

test('gap scanner creates exact candidates for snapshot minutes', () => {
  const result = buildExpectedMinuteCandidates([
    snapshot(1),
    snapshot(2),
  ], {
    from: MINUTE_MS,
    to: 3 * MINUTE_MS,
  });

  assert.deepEqual(result.candidates.map((item) => [item.minuteAt, item.rebuild.mode]), [
    [MINUTE_MS, 'exact'],
    [2 * MINUTE_MS, 'exact'],
  ]);
});

test('gap scanner fills long gaps within the configured carry limit', () => {
  const result = buildExpectedMinuteCandidates([
    snapshot(1),
    snapshot(8),
  ], {
    from: MINUTE_MS,
    to: 9 * MINUTE_MS,
    maxCarryMinutes: 10,
  });

  assert.equal(result.sourceGapMinutes, 6);
  assert.deepEqual(result.candidates.map((item) => item.minuteAt), [
    1, 2, 3, 4, 5, 6, 7, 8,
  ].map((minute) => minute * MINUTE_MS));
  assert.equal(result.candidates.filter((item) => item.rebuild.mode === 'carry_forward').length, 6);
});

test('gap scanner does not carry data across broadcasts', () => {
  const result = buildExpectedMinuteCandidates([
    snapshot(1),
    snapshot(8, { broadcast_start_time: 2_000 }),
  ], {
    from: MINUTE_MS,
    to: 9 * MINUTE_MS,
    maxCarryMinutes: 10,
  });

  assert.deepEqual(result.candidates.map((item) => item.minuteAt), [MINUTE_MS, 8 * MINUTE_MS]);
  assert.equal(result.sourceGapMinutes, 0);
});

test('gap scanner reports but does not synthesize gaps above its safety limit', () => {
  const result = buildExpectedMinuteCandidates([
    snapshot(1),
    snapshot(20),
  ], {
    from: MINUTE_MS,
    to: 21 * MINUTE_MS,
    maxCarryMinutes: 5,
  });

  assert.equal(result.sourceGapMinutes, 18);
  assert.deepEqual(result.candidates.map((item) => item.minuteAt), [MINUTE_MS, 20 * MINUTE_MS]);
});

test('gap scanner stays on a window while any missing minute remains', () => {
  assert.equal(nextGapScanCursor({
    from: 100,
    to: 200,
    earliest: 0,
    cutoff: 1_000,
    missingCount: 96,
  }), 200);
});

test('gap scanner advances only after the current window is complete', () => {
  assert.equal(nextGapScanCursor({
    from: 100,
    to: 200,
    earliest: 0,
    cutoff: 1_000,
    missingCount: 0,
  }), 100);
  assert.equal(nextGapScanCursor({
    from: 0,
    to: 100,
    earliest: 0,
    cutoff: 1_000,
    missingCount: 0,
  }), 1_000);
});
