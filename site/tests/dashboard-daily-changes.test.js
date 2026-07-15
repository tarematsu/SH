import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UTC_DAILY_METRICS_SQL,
  dailyChangesFromRows,
  onRequestGet,
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

test('daily dashboard changes compare consecutive completed UTC day ends', () => {
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

test('daily dashboard SQL uses real stream counts without listener fallback', () => {
  assert.match(UTC_DAILY_METRICS_SQL, /reported_current_stream_count/);
  assert.match(UTC_DAILY_METRICS_SQL, /sh_total_member_daily/);
  assert.doesNotMatch(UTC_DAILY_METRICS_SQL, /total_listens/);
});

test('daily changes endpoint returns yesterday and day-before-yesterday growth', async () => {
  const db = new FakeD1Database().route('all', 'WITH latest_channel AS', ({ params }) => ({
    results: [
      { day_at: params[0], member_end: 200, stream_end: 2_000 },
      { day_at: params[1], member_end: 207, stream_end: 2_040 },
      { day_at: params[2], member_end: 218, stream_end: 2_095 },
    ],
  }));

  const response = await onRequestGet({ env: { MINUTE_DB: db } });
  const payload = await responseJson(response);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.timezone, 'UTC');
  assert.equal(payload.yesterday.member_growth, 11);
  assert.equal(payload.yesterday.stream_growth, 55);
  assert.equal(payload.day_before_yesterday.member_growth, 7);
  assert.equal(payload.day_before_yesterday.stream_growth, 40);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].params.length, 3);
});
