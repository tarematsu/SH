import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseAuthState } from '../worker/src/auth-state.js';
import { collectorStateFromAuthState } from '../worker/src/index.js';
import { authHealth, withAuthState } from '../worker/src/optimized-index.js';
import { loadTrackLikeRows } from '../site/functions/lib/track-likes.js';
import { loadHostSummary } from '../site/functions/api/host-history.js';

test('auth state carries collector fields for same-invocation reuse', () => {
  const state = parseAuthState({
    auth_token: 'token',
    device_uid: 'device',
    token_expires_at: 100,
    collector_last_run_at: 200,
    collector_last_success_at: 300,
    collector_last_error: 'old error',
    collector_channel_id: 400,
    collector_station_id: 500,
    collector_updated_at: 600,
    last_attempt_at: 700,
    last_success_at: 800,
    last_error: 'auth error',
    lock_until: 900,
    control_id: 'stationhead',
  });

  assert.equal(state.collectorLastRunAt, 200);
  assert.equal(state.collectorLastSuccessAt, 300);
  assert.equal(state.collectorLastError, 'old error');
  assert.equal(state.collectorChannelId, 400);
  assert.equal(state.collectorStationId, 500);
  assert.equal(state.collectorUpdatedAt, 600);
  assert.equal(state.lastSuccessAt, 800);
});

test('collector converts the already-read auth state without another DB query', () => {
  const authState = {
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 100,
    collectorLastRunAt: 200,
    collectorLastSuccessAt: 300,
    collectorLastError: null,
    collectorChannelId: 400,
    collectorStationId: 500,
  };
  const state = collectorStateFromAuthState(authState);
  assert.deepEqual(state, {
    authToken: 'token',
    deviceUid: 'device',
    tokenExpiresAt: 100,
    lastRunAt: 200,
    lastSuccessAt: 300,
    lastError: null,
    channelId: 400,
    stationId: 500,
  });

  const env = withAuthState({ DB: { marker: true }, RUN_SECRET: 'secret' }, authState);
  assert.strictEqual(env.__stationheadAuthState, authState);
  assert.equal(env.RUN_SECRET, 'secret');
  assert.equal(env.DB.marker, true);
  assert.equal(authHealth(authState).auth_session_ready, true);
});

test('track likes use one D1 batch and preserve newest source row', async () => {
  let batchCalls = 0;
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
      };
      statements.push(statement);
      return statement;
    },
    async batch(items) {
      batchCalls += 1;
      assert.equal(items.length, 3);
      return [
        { results: [{ play_date: '2026-07-01', spotify_id: 'track', like_count: 30, observed_at: 300, source: 'collector' }] },
        { results: [{ play_date: '2026-07-01', spotify_id: 'track', like_count: 20, observed_at: 200, source: 'queue' }] },
        { results: [{ play_date: '2026-07-01', title: 'Track', artist: 'Artist', like_count: 10, observed_at: 100, source: 'sheet' }] },
      ];
    },
  };

  const rows = await loadTrackLikeRows(db, 1, 2);
  assert.equal(batchCalls, 1);
  assert.equal(statements.length, 3);
  assert.deepEqual(statements.map((statement) => statement.values), [[1, 2], [1, 2], [1, 2]]);
  const spotify = rows.find((row) => row.spotify_id === 'track');
  assert.equal(spotify.like_count, 30);
  assert.equal(spotify.source, 'collector');
});

test('host summary loads three result sets in one D1 batch', async () => {
  let batchCalls = 0;
  const db = {
    prepare(sql) { return { sql }; },
    async batch(statements) {
      batchCalls += 1;
      assert.equal(statements.length, 3);
      return [
        { results: [{ handle: 'sakuramankai', followers: 1 }] },
        { results: [{ handle: 'sakurazaka46jp', status: 'active' }] },
        { results: [{ id: 2 }, { id: 1 }] },
      ];
    },
  };

  const summary = await loadHostSummary(db);
  assert.equal(batchCalls, 1);
  assert.equal(summary.latestProfile.handle, 'sakuramankai');
  assert.equal(summary.activeSession.status, 'active');
  assert.deepEqual(summary.recentSessions.map((row) => row.id), [2, 1]);
});

test('dashboard delta layer reuses formatters and avoids legacy mutation helpers', () => {
  const source = readFileSync(new URL('../site/public/dashboard-optimized.js', import.meta.url), 'utf8');
  assert.match(source, /const integerFormatter = new Intl\.NumberFormat/);
  assert.match(source, /const dateTimeFormatter = new Intl\.DateTimeFormat/);
  assert.match(source, /function setImageIfChanged/);
  assert.match(source, /function renderDailyDeltaIfChanged/);
  const refreshBody = source.slice(source.indexOf('refresh = async function refreshDashboardDelta'));
  assert.doesNotMatch(refreshBody, /\bsetImage\(/);
  assert.doesNotMatch(refreshBody, /\brenderDailyDelta\(/);
  assert.doesNotMatch(refreshBody, /\bdateTime\(/);
  assert.doesNotMatch(refreshBody, /\bnumber\(/);
});
