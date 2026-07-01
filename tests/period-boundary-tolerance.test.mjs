import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  PERIOD_BOUNDARY_TOLERANCE_MS,
  evaluatePeriodCompleteness,
  expectedPeriodBounds,
} from '../site/functions/lib/period-completeness.js';
import {
  applyPeriodBoundaryEvidence,
  periodBoundaryEvidenceSql,
} from '../site/functions/lib/period-boundary-evidence.js';

test('both sides of each boundary are accepted within fifteen minutes', () => {
  const bounds = expectedPeriodBounds('daily', '2026-06-30');
  for (const offset of [-PERIOD_BOUNDARY_TOLERANCE_MS, PERIOD_BOUNDARY_TOLERANCE_MS]) {
    const result = evaluatePeriodCompleteness({
      mode: 'daily',
      periodKey: '2026-06-30',
      firstObservedAt: bounds.start + offset,
      lastObservedAt: bounds.end - offset,
      now: bounds.end + PERIOD_BOUNDARY_TOLERANCE_MS + 1,
    });
    assert.equal(result.complete, true);
  }
});

test('observations outside either tolerance edge are rejected', () => {
  const bounds = expectedPeriodBounds('daily', '2026-06-30');
  const outside = PERIOD_BOUNDARY_TOLERANCE_MS + 1;
  const entrance = evaluatePeriodCompleteness({
    mode: 'daily', periodKey: '2026-06-30',
    firstObservedAt: bounds.start - outside, lastObservedAt: bounds.end,
    now: bounds.end + outside,
  });
  const exit = evaluatePeriodCompleteness({
    mode: 'daily', periodKey: '2026-06-30',
    firstObservedAt: bounds.start, lastObservedAt: bounds.end + outside,
    now: bounds.end + outside,
  });
  assert.deepEqual(entrance.reasons, ['missing_period_start']);
  assert.deepEqual(exit.reasons, ['missing_period_end']);
});

test('the period stays current through the exit grace window', () => {
  const bounds = expectedPeriodBounds('daily', '2026-06-30');
  const result = evaluatePeriodCompleteness({
    mode: 'daily', periodKey: '2026-06-30',
    firstObservedAt: bounds.start, lastObservedAt: bounds.end,
    now: bounds.end + PERIOD_BOUNDARY_TOLERANCE_MS - 1,
  });
  assert.equal(result.complete, false);
  assert.ok(result.reasons.includes('current_period'));
});

test('one SQLite query selects nearest boundary evidence', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_channel_snapshots(
      id INTEGER PRIMARY KEY,observed_at INTEGER,current_stream_count INTEGER,
      total_listens INTEGER,total_member_count INTEGER
    );
    CREATE TABLE sh_legacy_snapshots(
      id INTEGER PRIMARY KEY,observed_at INTEGER,total_stream_count INTEGER,
      total_member_count INTEGER
    );
  `);
  const bounds = expectedPeriodBounds('daily', '2026-06-30');
  db.prepare('INSERT INTO sh_channel_snapshots VALUES(?,?,?,?,?)')
    .run(1, bounds.start - 10 * 60000, 100, null, 10);
  db.prepare('INSERT INTO sh_channel_snapshots VALUES(?,?,?,?,?)')
    .run(2, bounds.end + 10 * 60000, 160, null, 16);
  db.prepare('INSERT INTO sh_legacy_snapshots VALUES(?,?,?,?)')
    .run(1, bounds.start + 2 * 60000, 110, 11);
  db.prepare('INSERT INTO sh_legacy_snapshots VALUES(?,?,?,?)')
    .run(2, bounds.end - 2 * 60000, 150, 15);

  const rows = db.prepare(periodBoundaryEvidenceSql(true)).all(JSON.stringify([{
    period_key: '2026-06-30', period_start: bounds.start, period_end: bounds.end,
  }]));
  assert.equal(rows[0].boundary_start_at, bounds.start + 2 * 60000);
  assert.equal(rows[0].boundary_end_at, bounds.end - 2 * 60000);
  assert.equal(rows[0].stream_start, 110);
  assert.equal(rows[0].stream_end, 150);
});

test('old daily summary endpoints are replaced by UTC boundary evidence', () => {
  const bounds = expectedPeriodBounds('daily', '2026-06-30');
  const rows = applyPeriodBoundaryEvidence([{
    period_key: '2026-06-30', period_start: bounds.start - 9 * 3600000,
    period_end: bounds.end - 9 * 3600000, stream_growth: 1,
  }], new Map([['2026-06-30', {
    boundary_start_at: bounds.start - 5 * 60000,
    boundary_end_at: bounds.end + 5 * 60000,
    stream_start: 1000, stream_end: 1400,
    member_start: 100, member_end: 105,
  }]]));
  assert.equal(rows[0].period_start, bounds.start - 5 * 60000);
  assert.equal(rows[0].period_end, bounds.end + 5 * 60000);
  assert.equal(rows[0].stream_growth, 400);
  assert.equal(rows[0].member_growth, 5);
});
