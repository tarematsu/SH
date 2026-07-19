import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundedLiveSummaryStart,
  currentSummaryPeriodStart,
} from '../functions/lib/history-summary.js';

const NOW = Date.UTC(2026, 6, 19, 12, 34, 56);

test('live summary overlays start at the current UTC period', () => {
  assert.equal(currentSummaryPeriodStart('daily', NOW), Date.UTC(2026, 6, 19));
  assert.equal(currentSummaryPeriodStart('weekly', NOW), Date.UTC(2026, 6, 13));
  assert.equal(currentSummaryPeriodStart('monthly', NOW), Date.UTC(2026, 6, 1));
});

test('stale or missing rollups never reopen raw history before the current period', () => {
  const oldStart = Date.UTC(2024, 5, 1);
  assert.equal(
    boundedLiveSummaryStart('daily', oldStart, null, NOW),
    Date.UTC(2026, 6, 19),
  );
  assert.equal(
    boundedLiveSummaryStart('weekly', oldStart, Date.UTC(2025, 11, 31), NOW),
    Date.UTC(2026, 6, 13),
  );
  assert.equal(
    boundedLiveSummaryStart('monthly', oldStart, Date.UTC(2026, 5, 30), NOW),
    Date.UTC(2026, 6, 1),
  );
});

test('a newer completed rollup boundary still wins over the current-period floor', () => {
  const from = Date.UTC(2026, 6, 1);
  const lastBaseEnd = Date.UTC(2026, 6, 19, 6);
  assert.equal(
    boundedLiveSummaryStart('daily', from, lastBaseEnd, NOW),
    lastBaseEnd + 1,
  );
});
