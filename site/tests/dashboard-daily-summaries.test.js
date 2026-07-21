import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DAILY_SUMMARY_SQL,
  dashboardDailySummaries,
  loadDashboardDailySummaries,
  resetDashboardDailySummariesCache,
  utcDayStarts,
} from '../functions/lib/dashboard-daily-summaries.js';
import { FakeD1Database } from './helpers/fake-d1.js';

const dayText = (value) => new Date(value).toISOString().slice(0, 10);

test('dashboard daily summary boundaries use completed UTC days', () => {
  const starts = utcDayStarts(Date.UTC(2026, 6, 16, 14, 30));
  assert.deepEqual(starts, {
    currentStart: Date.UTC(2026, 6, 16),
    yesterdayStart: Date.UTC(2026, 6, 15),
    dayBeforeYesterdayStart: Date.UTC(2026, 6, 14),
  });
});

test('dashboard daily summaries preserve precomputed growth values', () => {
  const starts = utcDayStarts(Date.UTC(2026, 6, 16, 2));
  const summaries = dashboardDailySummaries([
    { period_key: '2026-07-14', member_growth: -152, stream_growth: 54_184 },
    { period_key: '2026-07-15', member_growth: -158, stream_growth: 53_036 },
  ], starts);

  assert.equal(summaries.source, 'sh_daily_summary');
  assert.deepEqual(summaries.yesterday, {
    period_key: '2026-07-15',
    start_at: starts.yesterdayStart,
    end_at: starts.currentStart,
    member_growth: -158,
    stream_growth: 53_036,
  });
  assert.deepEqual(summaries.day_before_yesterday, {
    period_key: '2026-07-14',
    start_at: starts.dayBeforeYesterdayStart,
    end_at: starts.yesterdayStart,
    member_growth: -152,
    stream_growth: 54_184,
  });
});

test('dashboard daily summary loader uses one cached OTHER_DB read', async () => {
  resetDashboardDailySummariesCache();
  const now = Date.UTC(2026, 6, 16, 2);
  const starts = utcDayStarts(now);
  const db = new FakeD1Database().route('all', 'FROM sh_daily_summary', () => ({
    results: [
      { period_key: dayText(starts.dayBeforeYesterdayStart), member_growth: 7, stream_growth: 40 },
      { period_key: dayText(starts.yesterdayStart), member_growth: 11, stream_growth: 55 },
    ],
  }));

  const first = await loadDashboardDailySummaries(db, now);
  const second = await loadDashboardDailySummaries(db, now + 1_000);
  assert.equal(first.yesterday.member_growth, 11);
  assert.deepEqual(second, first);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /FROM sh_daily_summary/);
  assert.match(DAILY_SUMMARY_SQL, /stream_growth/);
  assert.match(DAILY_SUMMARY_SQL, /member_growth/);
});

test('dashboard route composes daily summaries without owning their SQL', () => {
  const route = readFileSync(new URL('../functions/api/dashboard.js', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../functions/api/dashboard-core.js', import.meta.url), 'utf8');
  assert.match(route, /loadDashboardDailySummaries/);
  assert.match(route, /daily_summaries/);
  assert.match(route, /dashboardCore/);
  assert.doesNotMatch(route, /FROM sh_daily_summary/);
  assert.match(core, /loadFactsDashboard/);
});
