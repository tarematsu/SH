import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExpectedMinuteCandidates,
  loadGapScanSnapshots,
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

test('gap scanner carries each channel independently when snapshots are interleaved', () => {
  const result = buildExpectedMinuteCandidates([
    snapshot(1, { id: 11, channel_id: 1, station_id: 10, broadcast_start_time: 1_000 }),
    snapshot(2, { id: 22, channel_id: 2, station_id: 20, broadcast_start_time: 2_000 }),
    snapshot(4, { id: 14, channel_id: 1, station_id: 10, broadcast_start_time: 1_000 }),
    snapshot(5, { id: 25, channel_id: 2, station_id: 20, broadcast_start_time: 2_000 }),
  ], {
    from: MINUTE_MS,
    to: 6 * MINUTE_MS,
    maxCarryMinutes: 10,
  });

  assert.equal(result.sourceGapMinutes, 4);
  assert.deepEqual(result.candidates.map((item) => (
    `${item.snapshot.channel_id}:${item.minuteAt / MINUTE_MS}:${item.rebuild.mode}`
  )), [
    '1:1:exact',
    '1:2:carry_forward',
    '2:2:exact',
    '1:3:carry_forward',
    '2:3:carry_forward',
    '1:4:exact',
    '2:4:carry_forward',
    '2:5:exact',
  ]);
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

test('snapshot loading includes one pre-window boundary row for every active channel', async () => {
  const calls = [];
  const inWindow = [
    snapshot(4, { id: 40, channel_id: 1, station_id: 10, broadcast_start_time: 1_000 }),
    snapshot(5, { id: 50, channel_id: 2, station_id: 20, broadcast_start_time: 2_000 }),
  ];
  const previous = [
    snapshot(1, { id: 10, channel_id: 1, station_id: 10, broadcast_start_time: 1_000 }),
    snapshot(2, { id: 20, channel_id: 2, station_id: 20, broadcast_start_time: 2_000 }),
  ];
  const db = {
    prepare(sql) {
      const call = { sql, bindings: [] };
      calls.push(call);
      return {
        bind(...bindings) {
          call.bindings = bindings;
          return this;
        },
        async all() {
          return { results: sql.includes('ROW_NUMBER()') ? previous : inWindow };
        },
      };
    },
  };

  const rows = await loadGapScanSnapshots({ DB: db }, 3 * MINUTE_MS, 6 * MINUTE_MS);
  assert.deepEqual(rows.map((row) => row.id), [10, 20, 40, 50]);
  assert.match(calls[1].sql, /PARTITION BY channel_id/);
  assert.deepEqual(calls[1].bindings, [3 * MINUTE_MS, 1, 2]);

  const result = buildExpectedMinuteCandidates(rows, {
    from: 3 * MINUTE_MS,
    to: 6 * MINUTE_MS,
    maxCarryMinutes: 10,
  });
  assert.deepEqual(result.candidates.map((item) => (
    `${item.snapshot.channel_id}:${item.minuteAt / MINUTE_MS}:${item.rebuild.mode}`
  )), [
    '1:3:carry_forward',
    '2:3:carry_forward',
    '1:4:exact',
    '2:4:carry_forward',
    '2:5:exact',
  ]);
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
