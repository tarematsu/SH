import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestGet as dashboardGet } from '../functions/api/dashboard.js';
import { onRequestGet as dashboardHistoryGet } from '../functions/api/dashboard-history.js';
import { onRequestGet as dashboardRecoveryGet } from '../functions/api/dashboard-recovery.js';
import {
  FACTS_HISTORY_24H_SQL,
  FACTS_LATEST_SQL,
  FACTS_PREDICTION_24H_SQL,
  factsAreFresh,
  mergeFactsLatest,
} from '../functions/lib/dashboard-facts.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

test('facts dashboard SQL preserves the main-page response contract', () => {
  assert.match(FACTS_LATEST_SQL, /FROM sh_minute_facts AS f/);
  assert.match(FACTS_LATEST_SQL, /reported_total_listens AS total_listens/);
  assert.match(FACTS_LATEST_SQL, /reported_current_stream_count AS current_stream_count/);
  assert.match(FACTS_LATEST_SQL, /LEFT JOIN sh_minute_fact_context/);
  assert.match(FACTS_HISTORY_24H_SQL, /PARTITION BY CAST\(minute_at\/300000 AS INTEGER\)/);
  assert.match(FACTS_HISTORY_24H_SQL, /SUM\(recent\.comment_count\)/);
  assert.match(FACTS_PREDICTION_24H_SQL, /reported_current_stream_count/);
  assert.doesNotMatch(FACTS_HISTORY_24H_SQL, /sh_channel_snapshots/);
});

test('facts freshness rejects missing and delayed telemetry', () => {
  assert.equal(factsAreFresh({ observed_at: 940_000 }, 1_000_000), true);
  assert.equal(factsAreFresh({ observed_at: 700_000 }, 1_000_000), false);
  assert.equal(factsAreFresh(null, 1_000_000), false);
});

test('facts telemetry overrides DB metrics while retaining presentation fields', () => {
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

test('main dashboard prefers fresh FACTS_DB metrics and history over conflicting DB values', async () => {
  const now = Date.now();
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
    .route('first', 'FROM sh_minute_facts AS f\nLEFT JOIN sh_minute_fact_context', {
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
    .route('first', 'f.total_member_count AS total_member_count', {
      observed_at: now - 86_400_000,
      total_member_count: 30_500,
    })
    .route('first', 'f.reported_total_listens AS total_listens', {
      observed_at: now - 86_400_000,
      total_listens: 790_000,
    });

  const response = await dashboardGet({
    request: new Request('https://skrzk.test/api/dashboard'),
    env: { DB: db, FACTS_DB: facts },
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
  assert.equal(db.callsMatching(/HISTORY_24H_SQL|snapshots\.observed_at >=/).length, 0);
});

test('dashboard history and recovery select FACTS_DB when it is bound', async () => {
  const now = Date.now();
  const facts = new FakeD1Database()
    .route('first', 'FROM sh_minute_facts AS f\nLEFT JOIN sh_minute_fact_context', { observed_at: now - 1_000 })
    .route('all', 'WITH latest_channel AS', { results: [{ observed_at: now - 1_000, online_member_count: 12 }] })
    .route('all', 'SELECT channel_id,MAX(minute_at)', { results: [{ observed_at: now - 1_000, online_member_count: 12 }] });
  const forbiddenDb = {
    prepare() { throw new Error('legacy DB must not be queried'); },
  };
  const history = await responseJson(await dashboardHistoryGet({ env: { DB: forbiddenDb, FACTS_DB: facts } }));
  const recovery = await responseJson(await dashboardRecoveryGet({ env: { DB: forbiddenDb, FACTS_DB: facts } }));
  assert.equal(history.ok, true);
  assert.equal(history.storage_source, 'facts-db');
  assert.equal(history.history[0].online_member_count, 12);
  assert.equal(recovery.ok, true);
  assert.equal(recovery.storage_source, 'facts-db');
  assert.equal(recovery.rows[0].online_member_count, 12);
});

test('dashboard history does not fall back to the private buddies DB', async () => {
  const facts = new FakeD1Database().route(
    'all',
    'WITH latest_channel AS',
    () => { throw new Error('no such table: sh_minute_facts'); },
  );
  const db = new FakeD1Database().route('all', 'FROM sh_channel_snapshots', {
    results: [{ observed_at: 200, online_member_count: 9 }],
  });
  const payload = await responseJson(await dashboardHistoryGet({ env: { DB: db, FACTS_DB: facts } }));
  assert.equal(payload.ok, false);
  assert.equal(db.calls.length, 0);
});
