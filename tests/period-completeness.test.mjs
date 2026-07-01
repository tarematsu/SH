import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  applySummaryCompleteness,
  applyTrackPeriodCompleteness,
  currentPeriodKey,
  evaluatePeriodCompleteness,
  expectedPeriodBounds,
} from '../site/functions/lib/period-completeness.js';

const AFTER_JULY = Date.parse('2026-07-02T12:00:00Z');

test('daily period uses UTC boundaries corresponding to 09:00 Japan', () => {
  const bounds = expectedPeriodBounds('daily', '2026-07-01');
  assert.equal(bounds.start, Date.parse('2026-07-01T00:00:00Z'));
  assert.equal(bounds.end, Date.parse('2026-07-02T00:00:00Z'));
  assert.equal(new Date(bounds.start + 9 * 3600000).toISOString(), '2026-07-01T09:00:00.000Z');
});

test('completed daily period keeps stream growth', () => {
  const bounds = expectedPeriodBounds('daily', '2026-06-30');
  const result = applySummaryCompleteness([{
    period_key: '2026-06-30',
    period_start: bounds.start + 5 * 60000,
    period_end: bounds.end - 5 * 60000,
    stream_growth: 1234,
    quality_flags: '[]',
  }], 'daily', AFTER_JULY);

  assert.equal(result.excludedCount, 0);
  assert.equal(result.rows[0].stream_growth, 1234);
  assert.equal(result.rows[0].period_complete, true);
});

test('missing entrance or exit excludes stream growth', () => {
  const bounds = expectedPeriodBounds('daily', '2026-06-30');
  const result = applySummaryCompleteness([{
    period_key: '2026-06-30',
    period_start: bounds.start + 60 * 60000,
    period_end: bounds.end - 60 * 60000,
    stream_growth: 999,
    quality_flags: '[]',
  }], 'daily', AFTER_JULY);

  assert.equal(result.excludedCount, 1);
  assert.equal(result.rows[0].stream_growth, null);
  assert.deepEqual(result.rows[0].exclusion_reasons, ['missing_period_start', 'missing_period_end']);
  assert.match(result.rows[0].quality_flags, /incomplete_period_start/);
  assert.match(result.rows[0].quality_flags, /incomplete_period_end/);
});

test('April 30 daily growth is excluded as a known collection gap', () => {
  const bounds = expectedPeriodBounds('daily', '2026-04-30');
  const result = applySummaryCompleteness([{
    period_key: '2026-04-30',
    period_start: bounds.start,
    period_end: bounds.end,
    stream_growth: 5000,
    quality_flags: '[]',
  }], 'daily', AFTER_JULY);

  assert.equal(result.rows[0].stream_growth, null);
  assert.deepEqual(result.rows[0].exclusion_reasons, ['known_collection_gap']);
});

test('current day, week, and month are excluded', () => {
  const cases = [
    ['daily', '2026-07-02'],
    ['weekly', '2026-06-29'],
    ['monthly', '2026-07'],
  ];
  for (const [mode, periodKey] of cases) {
    const bounds = expectedPeriodBounds(mode, periodKey);
    const result = applySummaryCompleteness([{
      period_key: periodKey,
      period_start: bounds.start,
      period_end: AFTER_JULY,
      stream_growth: 100,
      quality_flags: '[]',
    }], mode, AFTER_JULY);
    assert.equal(result.rows[0].stream_growth, null, `${mode} should be excluded`);
    assert.ok(result.rows[0].exclusion_reasons.includes('current_period'));
  }
  assert.equal(currentPeriodKey('daily', AFTER_JULY), '2026-07-02');
  assert.equal(currentPeriodKey('weekly', AFTER_JULY), '2026-06-29');
  assert.equal(currentPeriodKey('monthly', AFTER_JULY), '2026-07');
});

test('January through June email weekly records remain trusted', () => {
  const result = applySummaryCompleteness([{
    period_key: '2026-06-29',
    period_start: Date.parse('2026-06-29T10:00:00+09:00'),
    period_end: Date.parse('2026-07-02T10:00:00+09:00'),
    stream_growth: 410074,
    quality_flags: '["stationhead_email_recap"]',
  }], 'weekly', AFTER_JULY);

  assert.equal(result.excludedCount, 0);
  assert.equal(result.rows[0].stream_growth, 410074);
  assert.equal(result.rows[0].period_complete, true);
});

test('July email-like weekly rows are not covered by the historical exception', () => {
  const evaluation = evaluatePeriodCompleteness({
    mode: 'weekly',
    periodKey: '2026-07-06',
    firstObservedAt: Date.parse('2026-07-06T10:00:00+09:00'),
    lastObservedAt: Date.parse('2026-07-07T10:00:00+09:00'),
    qualityFlags: '["stationhead_email_recap"]',
    now: Date.parse('2026-07-07T12:00:00Z'),
  });
  assert.equal(evaluation.complete, false);
  assert.equal(evaluation.trusted, false);
});

test('track rows retain details but incomplete dates are marked for total exclusion', () => {
  const completeBounds = expectedPeriodBounds('daily', '2026-06-30');
  const result = applyTrackPeriodCompleteness([
    { play_date: '2026-06-30', track_key: 'a', play_count: 3 },
    { play_date: '2026-07-02', track_key: 'b', play_count: 2 },
  ], [
    {
      play_date: '2026-06-30',
      period_first_observed_at: completeBounds.start + 5 * 60000,
      period_last_observed_at: completeBounds.end - 5 * 60000,
    },
    {
      play_date: '2026-07-02',
      period_first_observed_at: Date.parse('2026-07-02T00:05:00Z'),
      period_last_observed_at: AFTER_JULY,
    },
  ], AFTER_JULY);

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].play_count, 3);
  assert.equal(result.rows[0].play_count_excluded, false);
  assert.equal(result.rows[1].play_count, 2);
  assert.equal(result.rows[1].play_count_excluded, true);
  assert.deepEqual(result.excludedDates, ['2026-07-02']);
});

test('history page installs period filters before stable loading and bumps caches', () => {
  const html = readFileSync(new URL('../site/public/history/index.html', import.meta.url), 'utf8');
  const filterIndex = html.indexOf('/history/history-period-completeness.js');
  const loaderIndex = html.indexOf('/history/history-copy-fixes.js');
  assert.ok(filterIndex >= 0 && filterIndex < loaderIndex);

  const source = readFileSync(
    new URL('../site/public/history/history-period-completeness.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /この日の延べ曲数（集計対象外）/);
  assert.match(source, /track-history:v12:/);
  assert.match(source, /history:v10:/);
});
