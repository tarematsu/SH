import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadTrackHistoryData } from '../site/functions/lib/track-history-handler.js';
import { loadBroadcastSeriesRows } from '../site/functions/api/broadcast-series.js';
import {
  LEADERBOARD_CONTEXT_SQL,
  loadLeaderboardContext,
} from '../worker/src/cloud-weekly-leaderboard.js';

test('track history and compact realtime likes share one D1 batch', async () => {
  let batchCalls = 0;
  let allCalls = 0;
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async all() { allCalls += 1; return { results: [] }; },
      };
      statements.push(statement);
      return statement;
    },
    async batch(items) {
      batchCalls += 1;
      assert.equal(items.length, 2);
      return [
        { results: [{ play_date: '2026-07-01', play_count: 1 }] },
        { results: [{ play_date: '2026-07-01', spotify_id: 'track-1', like_count: 3, observed_at: 300, source: 'collector' }] },
      ];
    },
  };

  const loaded = await loadTrackHistoryData(db, 0, 86400000, 100, true);
  assert.equal(batchCalls, 1);
  assert.equal(allCalls, 0);
  assert.equal(statements.length, 2);
  assert.equal(loaded.result.results[0].play_count, 1);
  assert.equal(loaded.likeRows.length, 1);
  assert.equal(loaded.likeRows[0].like_count, 3);
  assert.equal(loaded.likeRows[0].source, 'collector');
});

test('broadcast legacy and fail-safe series share one D1 batch', async () => {
  let batchCalls = 0;
  let allCalls = 0;
  const db = {
    prepare(sql) {
      return {
        sql,
        bind(...values) { this.values = values; return this; },
        async all() { allCalls += 1; return { results: [] }; },
      };
    },
    async batch(items) {
      batchCalls += 1;
      assert.equal(items.length, 2);
      return [
        { results: [{ series_key: 'legacy:a', event_name: 'A', started_at: 100, points_json: '[[0,10,1]]', total_points: 1 }] },
        { results: [{ series_key: 'news:b', event_name: 'B', started_at: 200, points_json: '[[0,20,2]]', total_points: 1 }] },
      ];
    },
  };

  const loaded = await loadBroadcastSeriesRows(db, 0, 1000);
  assert.equal(batchCalls, 1);
  assert.equal(allCalls, 0);
  assert.equal(loaded.legacy[0].source, 'historical_import');
  assert.equal(loaded.legacy[0].samples[0].listener, 10);
  assert.equal(loaded.failSafe[0].source, 'official_news_fail_safe');
  assert.equal(loaded.failSafe[0].samples[0].sourceSamples, 2);
});

test('weekly leaderboard loads fetch state and auth session in one query', async () => {
  let prepares = 0;
  let firstCalls = 0;
  let bound = null;
  const env = {
    DB: {
      prepare(sql) {
        prepares += 1;
        assert.equal(sql, LEADERBOARD_CONTEXT_SQL);
        return {
          bind(...values) { bound = values; return this; },
          async first() {
            firstCalls += 1;
            return {
              fetched_at: 100,
              status: 'saved',
              source_hash: 'hash',
              auth_token: 'token',
              device_uid: 'device',
            };
          },
        };
      },
    },
  };

  const context = await loadLeaderboardContext(env, '2026-06-29');
  assert.equal(prepares, 1);
  assert.equal(firstCalls, 1);
  assert.deepEqual(bound, ['2026-06-29', 'stationhead_official_cloud']);
  assert.equal(context.auth_token, 'token');
  assert.equal(context.source_hash, 'hash');
});

test('history chart consolidates date and metric scans and reuses formatters', () => {
  const multiseries = readFileSync(
    new URL('../site/public/history/history-multiseries.js', import.meta.url),
    'utf8',
  );
  assert.match(multiseries, /const detailFormatter = new Intl\.NumberFormat/);
  assert.match(multiseries, /function prepareSeries\(/);
  assert.match(multiseries, /function positionsFromTimes\(/);
  assert.doesNotMatch(multiseries, /\.map\(dateTimestamp\)/);
  assert.doesNotMatch(multiseries, /sampled\.some\(/);

  const likes = readFileSync(
    new URL('../site/public/history/history-track-likes.js', import.meta.url),
    'utf8',
  );
  assert.match(likes, /const likeFormatter = new Intl\.NumberFormat/);
  assert.doesNotMatch(likes, /value\.toLocaleString/);
});
