import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { loadQueueComparisonState } from '../site/functions/lib/ingest.js';
import { COMMENT_VELOCITY_UPDATE_SQL } from '../site/functions/lib/comment-counts.js';
import {
  BROADCAST_SUMMARY_SQL,
  parseBroadcastSummaryRows,
} from '../site/functions/api/history.js';

test('queue items and latest likes share one D1 read batch', async () => {
  let batchCalls = 0;
  let directAllCalls = 0;
  const prepared = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async all() { directAllCalls += 1; return { results: [] }; },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      batchCalls += 1;
      assert.equal(statements.length, 2);
      return statements.map((statement) => {
        if (statement.sql.includes('FROM sh_queue_items')) {
          return { results: [{ position: 0, observed_at: 1000, spotify_id: 'track-a' }] };
        }
        if (statement.sql.includes('FROM sh_track_like_observations')) {
          return { results: [{ track_key: 'queue-1', observed_at: 1000, like_count: 4 }] };
        }
        throw new Error('unexpected statement');
      });
    },
  };

  const state = await loadQueueComparisonState(db, 7, 500, [0, 1], ['queue-1']);
  assert.equal(batchCalls, 1);
  assert.equal(directAllCalls, 0);
  assert.equal(prepared.length, 2);
  assert.equal(state.statementCount, 2);
  assert.equal(state.existingRows[0].spotify_id, 'track-a');
  assert.equal(state.latestRows[0].like_count, 4);
});

test('comment velocity is derived from compact minute counters', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_comment_minute_counts (
      station_id INTEGER NOT NULL,
      bucket_start INTEGER NOT NULL,
      comment_count INTEGER NOT NULL,
      PRIMARY KEY(station_id,bucket_start)
    );
    CREATE TABLE sh_channel_snapshots (
      id INTEGER PRIMARY KEY,
      station_id INTEGER,
      observed_at INTEGER,
      comment_velocity INTEGER
    );
    INSERT INTO sh_channel_snapshots VALUES (1,7,100000,NULL);
    INSERT INTO sh_channel_snapshots VALUES (2,7,200000,NULL);
    INSERT INTO sh_comment_minute_counts VALUES (7,80000,1);
    INSERT INTO sh_comment_minute_counts VALUES (7,190000,2);
    INSERT INTO sh_comment_minute_counts VALUES (7,200000,3);
    INSERT INTO sh_comment_minute_counts VALUES (7,79999,99);
    INSERT INTO sh_comment_minute_counts VALUES (8,200000,99);
  `);

  db.prepare(COMMENT_VELOCITY_UPDATE_SQL).run(
    7, 80000, 200000,
    7, 200000,
    7, 80000, 200000,
  );
  assert.equal(db.prepare('SELECT comment_velocity FROM sh_channel_snapshots WHERE id=2').get().comment_velocity, 6);
  assert.equal(db.prepare('SELECT comment_velocity FROM sh_channel_snapshots WHERE id=1').get().comment_velocity, null);
});

test('broadcast summary reports empty range and setup state in one query', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_official_broadcast_summary (
    host_handle TEXT NOT NULL,event_name TEXT NOT NULL,started_at INTEGER,
    ended_at INTEGER,started_jst TEXT,ended_jst TEXT,sample_count INTEGER,
    listener_avg REAL,listener_max INTEGER,likes_max INTEGER,distinct_tracks INTEGER,
    PRIMARY KEY(host_handle,event_name)
  )`);

  const empty = parseBroadcastSummaryRows(db.prepare(BROADCAST_SUMMARY_SQL).all(0, 100, 0, 100));
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.setupRequired, true);

  db.prepare(`INSERT INTO sh_official_broadcast_summary
    (host_handle,event_name,started_at,ended_at,started_jst,ended_jst,sample_count,listener_avg,listener_max,likes_max,distinct_tracks)
    VALUES ('sakurazaka46jp','Event A',1000,2000,'2026-07-01 00:00:01','2026-07-01 00:00:02',2,25,25,3,1)`).run();

  const outside = parseBroadcastSummaryRows(db.prepare(BROADCAST_SUMMARY_SQL).all(0, 100, 0, 100));
  assert.deepEqual(outside.rows, []);
  assert.equal(outside.setupRequired, false);

  const inside = parseBroadcastSummaryRows(db.prepare(BROADCAST_SUMMARY_SQL).all(0, 2000, 0, 2000));
  assert.equal(inside.setupRequired, false);
  assert.equal(inside.rows.length, 1);
  assert.equal(inside.rows[0].event_name, 'Event A');
  assert.equal(inside.rows[0].listener_avg, 25);
  assert.equal(Object.hasOwn(inside.rows[0], 'has_data'), false);
});

test('history display layer uses current canonical modules only', () => {
  const source = readFileSync(
    new URL('../site/public/history/history-lite.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /CACHE_PREFIX = 'sh\.history\.v3:'/);
  assert.match(source, /tracks: \{ label: '楽曲'/);
  assert.match(source, /broadcasts: \{ label: '公式配信比較'/);
});
