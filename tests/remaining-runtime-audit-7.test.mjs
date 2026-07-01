import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  COMMENT_VELOCITY_UPDATE_SQL,
  loadQueueComparisonState,
} from '../site/functions/api/ingest.js';
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

test('comment velocity is counted and written by one SQL statement', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_comments (
      id INTEGER PRIMARY KEY,
      station_id INTEGER,
      observed_at INTEGER,
      chat_time INTEGER,
      chat_time_ms INTEGER
    );
    CREATE TABLE sh_channel_snapshots (
      id INTEGER PRIMARY KEY,
      station_id INTEGER,
      observed_at INTEGER,
      comment_velocity INTEGER
    );
    INSERT INTO sh_channel_snapshots VALUES (1,7,100000,NULL);
    INSERT INTO sh_channel_snapshots VALUES (2,7,200000,NULL);
    INSERT INTO sh_comments VALUES (1,7,190000,NULL,NULL);
    INSERT INTO sh_comments VALUES (2,7,199000,NULL,NULL);
    INSERT INTO sh_comments VALUES (3,7,70000,NULL,NULL);
    INSERT INTO sh_comments VALUES (4,8,199500,NULL,NULL);
  `);

  db.prepare(COMMENT_VELOCITY_UPDATE_SQL).run(7, 80000, 200000, 7, 200000);
  assert.equal(db.prepare('SELECT comment_velocity FROM sh_channel_snapshots WHERE id=2').get().comment_velocity, 2);
  assert.equal(db.prepare('SELECT comment_velocity FROM sh_channel_snapshots WHERE id=1').get().comment_velocity, null);
});

test('broadcast summary reports empty range and setup state in one query', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_legacy_snapshots (
    id INTEGER PRIMARY KEY,
    observed_at INTEGER,
    observed_jst TEXT,
    listener_count INTEGER,
    likes INTEGER,
    track_title TEXT,
    host_handle TEXT,
    source_note TEXT
  )`);

  const empty = parseBroadcastSummaryRows(db.prepare(BROADCAST_SUMMARY_SQL).all(0, 100));
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.setupRequired, true);

  db.prepare(`INSERT INTO sh_legacy_snapshots
    (id,observed_at,observed_jst,listener_count,likes,track_title,host_handle,source_note)
    VALUES (1,1000,'2026-07-01 00:00:01',25,3,'Song','sakurazaka46jp','Event A')`).run();

  const outside = parseBroadcastSummaryRows(db.prepare(BROADCAST_SUMMARY_SQL).all(0, 100));
  assert.deepEqual(outside.rows, []);
  assert.equal(outside.setupRequired, false);

  const inside = parseBroadcastSummaryRows(db.prepare(BROADCAST_SUMMARY_SQL).all(0, 2000));
  assert.equal(inside.setupRequired, false);
  assert.equal(inside.rows.length, 1);
  assert.equal(inside.rows[0].event_name, 'Event A');
  assert.equal(inside.rows[0].listener_avg, 25);
  assert.equal(Object.hasOwn(inside.rows[0], 'has_data'), false);
});

test('history display layer avoids repeated canvas resets and temporary date arrays', () => {
  const source = readFileSync(
    new URL('../site/public/history/history-track-performance.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /prepareCanvasDifferential/);
  assert.match(source, /if \(canvas\.width !== pixelWidth\)/);
  assert.match(source, /setChartRangeSinglePass/);
  assert.match(source, /makeXPositionsSinglePass/);
  assert.match(source, /url\.searchParams\.set\('v', '14'\)/);
  assert.doesNotMatch(source, /dates\.filter\(Boolean\)/);
  assert.doesNotMatch(source, /dates\.map\(dateTimestamp\)/);
});
