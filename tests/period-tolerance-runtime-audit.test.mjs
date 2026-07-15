import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import {
  MONTHLY_BOUNDARY_TOLERANCE_MS,
  WEEKLY_BOUNDARY_TOLERANCE_MS,
  evaluatePeriodCompleteness,
  expectedPeriodBounds,
  periodBoundaryToleranceMs,
} from '../site/functions/lib/period-completeness.js';
import {
  periodBoundaryEvidenceSql,
  rowsRequiringBoundaryEvidence,
  summaryRowNeedsBoundaryEvidence,
} from '../site/functions/lib/period-boundary-evidence.js';

function createDb() {
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
  return db;
}

test('weekly uses twelve hours and monthly uses two days', () => {
  assert.equal(periodBoundaryToleranceMs('weekly'), 12 * 60 * 60 * 1000);
  assert.equal(periodBoundaryToleranceMs('monthly'), 2 * 86400000);

  for (const [mode, key, tolerance] of [
    ['weekly', '2026-07-06', WEEKLY_BOUNDARY_TOLERANCE_MS],
    ['monthly', '2026-05', MONTHLY_BOUNDARY_TOLERANCE_MS],
  ]) {
    const bounds = expectedPeriodBounds(mode, key);
    const accepted = evaluatePeriodCompleteness({
      mode,
      periodKey: key,
      firstObservedAt: bounds.start - tolerance,
      lastObservedAt: bounds.end + tolerance,
      now: bounds.end + tolerance + 1,
    });
    assert.equal(accepted.complete, true);

    const rejected = evaluatePeriodCompleteness({
      mode,
      periodKey: key,
      firstObservedAt: bounds.start - tolerance - 1,
      lastObservedAt: bounds.end,
      now: bounds.end + tolerance + 1,
    });
    assert.ok(rejected.reasons.includes('missing_period_start'));
  }
});

test('boundary SQL accepts observations inside expanded weekly and monthly windows', () => {
  const db = createDb();
  const weekly = expectedPeriodBounds('weekly', '2026-07-06');
  const monthly = expectedPeriodBounds('monthly', '2026-05');
  const insert = db.prepare('INSERT INTO sh_channel_snapshots VALUES(?,?,?,?,?)');
  insert.run(1, weekly.start - 6 * 3600000, 100, null, 10);
  insert.run(2, weekly.end + 6 * 3600000, 160, null, 16);
  insert.run(3, monthly.start - 86400000, 200, null, 20);
  insert.run(4, monthly.end + 86400000, 260, null, 26);

  const weeklyRows = db.prepare(periodBoundaryEvidenceSql(WEEKLY_BOUNDARY_TOLERANCE_MS))
    .all(JSON.stringify([{ period_key: '2026-07-06', period_start: weekly.start, period_end: weekly.end }]));
  const monthlyRows = db.prepare(periodBoundaryEvidenceSql(MONTHLY_BOUNDARY_TOLERANCE_MS))
    .all(JSON.stringify([{ period_key: '2026-05', period_start: monthly.start, period_end: monthly.end }]));
  assert.equal(weeklyRows[0].stream_start, 100);
  assert.equal(weeklyRows[0].stream_end, 160);
  assert.equal(monthlyRows[0].stream_start, 200);
  assert.equal(monthlyRows[0].stream_end, 260);
});

test('complete weekly and monthly summaries skip redundant boundary scans', () => {
  const weekly = expectedPeriodBounds('weekly', '2026-07-06');
  const weeklyRow = {
    period_key: '2026-07-06',
    period_start: weekly.start + 6 * 3600000,
    period_end: weekly.end - 6 * 3600000,
    stream_growth: 100,
    member_growth: 2,
  };
  assert.equal(summaryRowNeedsBoundaryEvidence(weeklyRow, 'weekly'), false);
  assert.equal(rowsRequiringBoundaryEvidence(
    [weeklyRow],
    'weekly',
    weekly.end + WEEKLY_BOUNDARY_TOLERANCE_MS + 1,
  ).length, 0);

  const monthly = expectedPeriodBounds('monthly', '2026-05');
  const monthlyRow = {
    period_key: '2026-05',
    period_start: monthly.start - 86400000,
    period_end: monthly.end + 86400000,
    stream_growth: 100,
    member_growth: 2,
  };
  assert.equal(summaryRowNeedsBoundaryEvidence(monthlyRow, 'monthly'), false);
});

test('history runtime uses server completeness and single-pass summary updates', () => {
  const filter = readFileSync(
    new URL('../site/public/history/history-period-completeness.js', import.meta.url),
    'utf8',
  );
  assert.match(filter, /track-history:v13:/);
  assert.match(filter, /history:v11:/);
  assert.doesNotMatch(filter, /mondayJstKey|expectedStart|expectedEnd/);

  const runtime = readFileSync(
    new URL('../site/public/history/history-track-likes.js', import.meta.url),
    'utf8',
  );
  assert.match(runtime, /updateSummaryRuntimeSinglePass/);
  assert.doesNotMatch(runtime, /rows\.filter\(\(row\).*host_name/s);
});
