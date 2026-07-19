import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundedLiveSummaryStart,
  currentSummaryPeriodStart,
  liveSummaryFallbackStart,
} from '../functions/lib/history-summary.js';

const NOW = Date.UTC(2026, 6, 19, 12, 34, 56);

test('live summary periods use UTC boundaries', () => {
  assert.equal(currentSummaryPeriodStart('daily', NOW), Date.UTC(2026, 6, 19));
  assert.equal(currentSummaryPeriodStart('weekly', NOW), Date.UTC(2026, 6, 13));
  assert.equal(currentSummaryPeriodStart('monthly', NOW), Date.UTC(2026, 6, 1));
});

test('missing or stale rollups reopen only a bounded recent raw tail', () => {
  const oldStart = Date.UTC(2024, 5, 1);
  assert.equal(liveSummaryFallbackStart('daily', NOW), Date.UTC(2026, 6, 18));
  assert.equal(liveSummaryFallbackStart('weekly', NOW), Date.UTC(2026, 5, 29));
  assert.equal(liveSummaryFallbackStart('monthly', NOW), Date.UTC(2026, 4, 1));
  assert.equal(
    boundedLiveSummaryStart('daily', oldStart, null, NOW),
    Date.UTC(2026, 6, 18),
  );
  assert.equal(
    boundedLiveSummaryStart('weekly', oldStart, Date.UTC(2025, 11, 31), NOW),
    Date.UTC(2026, 5, 29),
  );
  assert.equal(
    boundedLiveSummaryStart('monthly', oldStart, Date.UTC(2026, 3, 30), NOW),
    Date.UTC(2026, 4, 1),
  );
});

test('a newer completed rollup boundary still wins over the fallback floor', () => {
  const from = Date.UTC(2026, 6, 1);
  const lastBaseEnd = Date.UTC(2026, 6, 19, 6);
  assert.equal(
    boundedLiveSummaryStart('daily', from, lastBaseEnd, NOW),
    lastBaseEnd + 1,
  );
});
