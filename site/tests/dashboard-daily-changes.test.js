import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAILY_SUMMARY_SQL,
  UTC_DAILY_METRICS_SQL,
  dailyChangesFromRows,
  onRequestGet,
  summaryChangesFromRows,
  utcDayStarts,
} from '../functions/api/dashboard-daily-changes.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

test('UTC dashboard day boundaries always start at 00:00 UTC', () => {
  const starts = utcDayStarts(Date.UTC(2026, 6, 16, 14, 30));
  assert.deepEqual(starts, {
    currentStart: Date.UTC(2026, 6, 16),
    yesterdayStart: Date.UTC(2026, 6, 15),
    dayBeforeYesterdayStart: Date.UTC(2026, 6, 14),
    threeDaysAgoStart: Date.UTC(2026, 6, 13),
  });
});

test('legacy daily dashboard changes compare consecutive completed UTC day ends', () => {
  const starts = utcDayStarts(Date.UTC(2026, 6, 16, 2));
  const changes = dailyChangesFromRows([
    { day_at: starts.threeDaysAgoStart, member_end: 100, stream_end: 1_000 },
    { day_at: starts.dayBeforeYesterdayStart, member_end: 106, stream_end: 1_030 },
    { day_at: starts.yesterdayStart, member_end: 115, stream_end: 1_080 },
  ], starts);

  assert.equal(changes.timezone, 'UTC');
  assert.equal(changes.yesterday.period_key, '2026-07-15');
  assert.equal(changes.yesterday.member_growth, 9);
  assert.equal(changes.yesterday.stream_growth, 50);
  assert.equal(changes.day_before_yesterday.period_key, '2026-07-14');
  assert.equal(changes.day_before_yesterday.member_growth, 6);
  assert.equal(changes.day_before_yesterday.stream_growth, 30);
});

test('dashboard summary rows are returned without recomputing growth', () => {
  const starts = utcDayStarts(Date.UTC(2026, 6, 16, 2));
  const changes = summaryChangesFromRows([
    { period_key: '2026-07-14', member_growth: -152, stream_growth: 54_184 },
    { period_key: '2026-07-15', member_growth: -158, stream_growth: 53_036 },
  ], starts);

  assert.equal(changes.source, 'sh_daily_summary');
  assert.deepEqual(changes.yesterday, {
    period_key: '2026-07-15',
    start_at: starts.yesterdayStart,
    end_at: starts.currentStart,
    member_growth: -158,
    stream_growth: 53_036,
  });
  assert.deepEqual(changes.day_before_yesterday, {
    period_key: '2026-07-14',
    start_at: starts.dayBeforeYesterdayStart,
    end_at: starts.yesterdayStart,
    member_growth: -152,
    stream_growth: 54_184,
  });
});

test('daily dashboard SQL uses the completed daily summary fields', () => {
  assert.match(DAILY_SUMMARY_SQL, /FROM sh_daily_summary/);
  assert.match(DAILY_SUMMARY_SQL, /stream_growth/);
  assert.match(DAILY_SUMMARY_SQL, /member_growth/);
  assert.match(UTC_DAILY_METRICS_SQL, /reported_current_stream_count/);
});

test('daily changes endpoint returns completed summary rows from OTHER_DB', async () => {
  const db = new FakeD1Database().route('all', 'FROM sh_daily_summary', () => ({
    results: [
      { period_key: '2026-07-14', member_growth: 7, stream_growth: 40 },
      { period_key: '2026-07-15', member_growth: 11, stream_growth: 55 },
    ],
  }));

  const response = await onRequestGet({ env: { OTHER_DB: db } });
  const payload = await responseJson(response);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.source, 'sh_daily_summary');
  assert.equal(payload.yesterday.member_growth, 11);
  assert.equal(payload.yesterday.stream_growth, 55);
  assert.equal(payload.day_before_yesterday.member_growth, 7);
  assert.equal(payload.day_before_yesterday.stream_growth, 40);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /FROM sh_daily_summary/);
});
