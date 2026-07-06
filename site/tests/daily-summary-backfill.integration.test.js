import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  currentPeriodKey,
  expectedPeriodBounds,
  parseRangeStart,
} from '../functions/lib/period-completeness.js';
import { liveSummarySql } from '../functions/lib/history-summary.js';
import {
  previousUtcDay,
  utcMonthlyRange,
  utcWeeklyRange,
} from '../functions/lib/utc-periods.js';

const migration = readFileSync(
  new URL('../../database/migrations/106_backfill_missing_daily_summaries.sql', import.meta.url),
  'utf8',
);

test('daily summary backfill covers June 26 through July 3 using both collector stores', () => {
  assert.match(migration, /SELECT '2026-06-26'/);
  assert.match(migration, /period_key<'2026-07-03'/);
  assert.match(migration, /2026-06-26 00:00:00/);
  assert.match(migration, /2026-07-04 00:00:00/);
  assert.match(migration, /FROM sh_channel_snapshots/);
  assert.match(migration, /FROM sh_legacy_history_rows/);
  assert.match(migration, /ON CONFLICT\(period_key\) DO UPDATE SET/);
  assert.match(migration, /historical_gap_backfill/);
  assert.match(migration, /utc_period/);
});

test('daily summary boundaries and live grouping use UTC', () => {
  const bounds = expectedPeriodBounds('daily', '2026-06-26');
  assert.equal(bounds.start, Date.parse('2026-06-26T00:00:00Z'));
  assert.equal(bounds.end, Date.parse('2026-06-27T00:00:00Z'));
  assert.equal(parseRangeStart('daily', '2026-06-26', '2024-06-01'), bounds.start);
  assert.doesNotMatch(liveSummarySql('daily'), /\+9 hours/);
  assert.match(liveSummarySql('daily'), /'unixepoch'/);
});

test('current daily key remains on the UTC date around the Japan boundary', () => {
  const now = Date.parse('2026-06-25T16:00:00Z');
  assert.equal(currentPeriodKey('daily', now), '2026-06-25');
});

test('maintenance derives daily weekly and monthly periods in UTC', () => {
  assert.deepEqual(previousUtcDay(Date.parse('2026-07-06T00:15:00Z')), {
    key: '2026-07-05',
    start: Date.parse('2026-07-05T00:00:00Z'),
    end: Date.parse('2026-07-06T00:00:00Z'),
  });
  assert.deepEqual(utcWeeklyRange('2026-07-05'), {
    key: '2026-06-29',
    startKey: '2026-06-29',
    endKey: '2026-07-06',
  });
  assert.deepEqual(utcMonthlyRange('2026-07-05'), {
    key: '2026-07',
    startKey: '2026-07-01',
    endKey: '2026-08-01',
  });
});
