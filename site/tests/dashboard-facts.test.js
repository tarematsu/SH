import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestGet as dashboardGet } from '../functions/api/dashboard.js';
import {
  FACTS_HISTORY_24H_SQL,
  FACTS_HISTORY_SINCE_SQL,
  FACTS_LATEST_SQL,
  FACTS_PREDICTION_24H_SQL,
  factsAreFresh,
  mergeFactsLatest,
} from '../functions/lib/dashboard-facts.js';
import { resetDashboardDailySummariesCache } from '../functions/lib/dashboard-daily-summaries.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

const dayText = (value) => new Date(value).toISOString().slice(0, 10);

test('facts dashboard SQL preserves the unified dashboard response contract', () => {
  assert.match(FACTS_LATEST_SQL, /FROM sh_minute_facts AS f/);
  assert.match(FACTS_LATEST_SQL, /INDEXED BY idx_sh_minute_facts_live_minute/);
  assert.match(FACTS_LATEST_SQL, /recent INDEXED BY idx_sh_minute_facts_source_channel_minute_desc/);
  assert.match(FACTS_LATEST_SQL, /reported_total_listens AS total_listens/);
  assert.match(FACTS_LATEST_SQL, /reported_current_stream_count AS current_stream_count/);
  assert.match(FACTS_LATEST_SQL, /LEFT JOIN sh_minute_fact_context_v2/);
  assert.doesNotMatch(FACTS_LATEST_SQL, /LEFT JOIN sh_minute_fact_context AS/);
  assert.match(FACTS_LATEST_SQL, /WHERE f\.source_code=1/);
  assert.match(FACTS_HISTORY_24H_SQL, /PARTITION BY CAST\(minute_at\/300000 AS INTEGER\)/);
  assert.match(FACTS_HISTORY_24H_SQL, /RANGE BETWEEN 60000 PRECEDING AND CURRENT ROW/);
  assert.match(FACTS_HISTORY_24H_SQL, /d\.daily_rank=1/);
  assert.match(FACTS_HISTORY_24H_SQL, /WHERE f\.source_code=1/);
  assert.doesNotMatch(FACTS_HISTORY_24H_SQL, /SELECT SUM\(recent\.comment_count\)/);
  assert.doesNotMatch(FACTS_HISTORY_24H_SQL, /SELECT d\.last_total_member_count/);
  assert.match(FACTS_HISTORY_SINCE_SQL, /SUM\(recent\.comment_count\)/);
  assert.match(FACTS_HISTORY_SINCE_SQL, /SELECT d\.last_total_member_count/);
  assert.match(FACTS_PREDICTION_24H_SQL, /reported_current_stream_count/);
  assert.match(FACTS_PREDICTION_24H_SQL, /WHERE source_code=1/);
  assert.doesNotMatch(FACTS_HISTORY_24H_SQL, /sh_channel_snapshots/);
});

test('facts freshness rejects missing and delayed telemetry', () => {
  assert.equal(factsAreFresh({ observed_at: 940_000 }, 1_000_000), true);
  assert.equal(factsAreFresh({ observed_at: 399_999 }, 1_000_000), false);
  assert.equal(factsAreFresh(null, 1_000_000), false);
});

test('facts telemetry overrides collector metrics while retaining presentation fields', () => {
  const merged = mergeFactsLatest({
    observed_at: 10,
    channel_name: 'Buddies',
    raw_json: '{"description":"kept"}',
    stream_goal: 50_000_000,
    online_member_count: 1,
  }, {
    observed_at: 20,
    online_member_count: 167,
    current_stream_count: 49_127_261,
  });
  assert.equal(merged.channel_name, 'Buddies');
  assert.equal(merged.raw_json, '{"description":"kept"}');
  assert.equal(merged.stream_goal, 50_000_000);
  assert.equal(merged.observed_at, 20);
  assert.equal(merged.online_member_count, 167);
});

test('unified dashboard includes facts, history and completed daily summaries', async () => {
  resetDashboardDailySummariesCache();
  const now = Date.now();
  const currentDay = Math.floor(now / 86_400_000) * 86_400_000;
  const db = new FakeD1Database()
    .route('first', 'FROM sh_channel_snapshots AS snapshots ORDER BY', {
      id: 1,
      observed_at: now - 1_000,
      channel_id: 318,
      channel_alias: 'buddies',
      channel_name: 'Buddies',
      station_id: 3328626,
      online_member_count: 4,
      total_member_count: 5,
      total_listens: 6,
      stream_goal: 50_000_000,
      current_stream_count: 7,
      raw_json: '{}',
    })
    .route('all', 'WITH latest_station AS', { results: [] });
  const facts = new FakeD1Database()
    .route('first', 'FROM sh_minute_facts AS f INDEXED BY idx_sh_minute_facts_live_minute', {
      id: 10,
      observed_at: now - 2_000,
      channel_id: 318,
      station_id: 3328626,
      host_id: 1,
      online_member_count: 167,
      total_member_count: 30_599,
      total_listens: 790_366,
      current_stream_count: 49_127_261,
      host_handle: 'sakuramankai',
    })
    .route('all', 'WITH latest_channel AS', {
      results: [{ observed_at: now - 2_000, online_member_count: 167, current_stream_count: 49_127_261 }],
    })
    .route('first', 'FROM sh_channel_read_model', {
      channel_id: 318,
      observed_at: now - 2_000,
      presentation_json: JSON.stringify({
        channel_name: 'Buddies',
        channel_alias: 'buddies',
        stream_goal: 50_000_000,
      }),
    })
    .route('first', 'FROM sh_queue_read_model_current', null)
    .route('first', 'FROM sh_total_member_daily d', {
      observed_at: now - 86_400_000,
      total_member_count: 30_500,
    })
    .route('first', 'f.reported_total_listens AS total_listens', {
      observed_at: now - 86_400_000,
      total_listens: 790_000,
    });
  const other = new FakeD1Database().route('all', 'FROM sh_daily_summary', {
    results: [
      { period_key: dayText(currentDay - 2 * 86_400_000), member_growth: 7, stream_growth: 40 },
      { period_key: dayText(currentDay - 86_400_000), member_growth: 11, stream_growth: 55 },
    ],
  });

  const response = await dashboardGet({
    request: new Request('https://skrzk.test/api/dashboard'),
    env: { DB: db, MINUTE_DB: facts, OTHER_DB: other },
  });
  const payload = await responseJson(response);
  assert.equal(response.status, 200);
  assert.equal(payload.metrics_source, 'facts-db');
  assert.equal(payload.latest.channel_name, 'Buddies');
  assert.equal(payload.latest.online_member_count, 167);
  assert.equal(payload.latest.current_stream_count, 49_127_261);
  assert.equal(payload.latest.stream_goal, 50_000_000);
  assert.equal(payload.history[0].online_member_count, 167);
  assert.equal(payload.daily_change.total_member_count, 99);
  assert.equal(payload.daily_change.total_listens, 366);
  assert.equal(payload.daily_summaries.yesterday.member_growth, 11);
  assert.equal(payload.daily_summaries.yesterday.stream_growth, 55);
  assert.equal(payload.daily_summaries.day_before_yesterday.member_growth, 7);
  assert.equal(other.calls.length, 1);
  assert.equal(db.callsMatching(/snapshots\.observed_at >=/).length, 0);
});
