import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadTrackHistoryData } from '../site/functions/lib/track-history-handler.js';
import { loadSakurazakaSeriesRows } from '../site/functions/api/sakurazaka46jp.js';

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

test('Sakurazaka series reads historical points from MINUTE_DB and events from OTHER_DB', async () => {
  let minuteCalls = 0;
  let otherCalls = 0;
  const minuteDb = {
    prepare() {
      return {
        bind() { return this; },
        async all() {
          minuteCalls += 1;
          return { results: [{ points_json: '[[0,10,1]]', point_count: 1, total_points: 1 }] };
        },
      };
    },
  };
  const otherDb = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          otherCalls += 1;
          if (sql.includes('sh_official_broadcast_summary')) {
            return { results: [{ event_name: 'A', started_at: 100, ended_at: 200 }] };
          }
          return { results: [{ series_key: 'news:b', event_name: 'B', started_at: 200, points_json: '[[0,20,2]]', total_points: 1 }] };
        },
      };
    },
  };

  const loaded = await loadSakurazakaSeriesRows(minuteDb, otherDb, 0, 1000);
  assert.equal(minuteCalls, 1);
  assert.equal(otherCalls, 2);
  assert.equal(loaded.historical[0].source, 'historical_import');
  assert.equal(loaded.historical[0].samples[0].listener, 10);
  assert.equal(loaded.failSafe[0].source, 'official_news_fail_safe');
  assert.equal(loaded.failSafe[0].samples[0].sourceSamples, 2);
});

test('history client owns chart, table, formatting, and cache logic in one module', () => {
  const source = readFileSync(
    new URL('../site/public/history/history-lite.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /const integer = new Intl\.NumberFormat/);
  assert.match(source, /const dateOnly = new Intl\.DateTimeFormat/);
  assert.match(source, /function drawSummaryChart/);
  assert.match(source, /function renderTable/);
  assert.match(source, /sessionStorage\.getItem/);
  assert.match(source, /sessionStorage\.setItem/);
  assert.doesNotMatch(source, /broadcast-series|history-current|mode === 'raw'/);
});
