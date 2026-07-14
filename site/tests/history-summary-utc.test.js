import assert from 'node:assert/strict';
import test from 'node:test';

import { liveSummarySql } from '../functions/lib/history-summary.js';
import {
  currentPeriodKey,
  expectedPeriodBounds,
  parseRangeStart,
} from '../functions/lib/period-completeness.js';
import { periodBoundaryEvidenceSql } from '../functions/lib/period-boundary-evidence.js';

test('summary SQL groups weekly and monthly live rows in UTC', () => {
  const sql = liveSummarySql('weekly');
  assert.match(sql, /strftime\('%w', observed_at \/ 1000, 'unixepoch'\)/);
  assert.doesNotMatch(sql, /\+9 hours/);
  assert.doesNotMatch(liveSummarySql('monthly'), /\+9 hours/);
});

test('summary period boundaries and range starts use UTC', () => {
  const weekly = expectedPeriodBounds('weekly', '2026-07-13');
  assert.deepEqual(weekly, {
    start: Date.parse('2026-07-13T00:00:00Z'),
    end: Date.parse('2026-07-20T00:00:00Z'),
  });
  const monthly = expectedPeriodBounds('monthly', '2026-07');
  assert.equal(monthly.start, Date.parse('2026-07-01T00:00:00Z'));
  assert.equal(parseRangeStart('weekly', '2026-07-13', '2026-01-01'), Date.parse('2026-07-13T00:00:00Z'));
  assert.equal(currentPeriodKey('weekly', Date.parse('2026-07-13T00:01:00Z')), '2026-07-13');
});

test('boundary evidence reads only current snapshots', () => {
  const sql = periodBoundaryEvidenceSql(true);
  assert.match(sql, /sh_channel_snapshots/);
  assert.doesNotMatch(sql, /sh_legacy_snapshots/);
});
