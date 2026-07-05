import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  currentPeriodKey,
  expectedPeriodBounds,
  parseRangeStart,
} from '../functions/lib/period-completeness.js';
import { liveSummarySql } from '../functions/lib/history-summary.js';

const migration = readFileSync(
  new URL('../../database/migrations/106_backfill_missing_daily_summaries.sql', import.meta.url),
  'utf8',
);

test('daily summary backfill covers June 26 through July 3 using both collector stores', () => {
  assert.match(migration, /SELECT '2026-06-26'/);
  assert.match(migration, /period_key<'2026-07-03'/);
  assert.match(migration, /FROM sh_channel_snapshots/);
  assert.match(migration, /FROM sh_legacy_history_rows/);
  assert.match(migration, /ON CONFLICT\(period_key\) DO UPDATE SET/);
  assert.match(migration, /historical_gap_backfill/);
});

test('daily summary boundaries and live grouping use JST', () => {
  const bounds = expectedPeriodBounds('daily', '2026-06-26');
  assert.equal(bounds.start, Date.parse('2026-06-26T00:00:00+09:00'));
  assert.equal(bounds.end, Date.parse('2026-06-27T00:00:00+09:00'));
  assert.equal(parseRangeStart('daily', '2026-06-26', '2024-06-01'), bounds.start);
  assert.match(liveSummarySql('daily'), /'\+9 hours'/);
});

test('current daily key follows JST around the UTC date boundary', () => {
  const now = Date.parse('2026-06-25T16:00:00Z');
  assert.equal(currentPeriodKey('daily', now), '2026-06-26');
});
