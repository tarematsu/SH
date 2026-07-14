import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { liveSummarySql, combineSummaryRows, BROADCAST_SUMMARY_SQL } from '../site/functions/api/history.js';

const legacyHistoryMigration = readFileSync(
  new URL('../database/migrations/101_add_lightweight_legacy_history.sql', import.meta.url),
  'utf8',
);
import { planLikeObservations, latestLikesSql } from '../site/functions/api/ingest.js';
import { listenerAggregateDelta } from '../site/functions/api/host-ingest.js';
import { cachedPrediction, resetPredictionCache } from '../site/functions/api/dashboard.js';

test('live daily history is aggregated by UTC day beginning at 09:00 in Japan', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_channel_snapshots(
    id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, listener_count INTEGER,
    total_member_count INTEGER,total_listens INTEGER,current_stream_count INTEGER,host_handle TEXT,
    validated_stream_count INTEGER
  )`);
  const insert = db.prepare('INSERT INTO sh_channel_snapshots VALUES(?,?,?,?,?,?,?,?)');
  const timestamp = (value) => Date.parse(value);
  insert.run(1, timestamp('2026-06-30T23:59:00Z'), 10, 100, 1000, null, 'a', 1000);
  insert.run(2, timestamp('2026-07-01T00:00:00Z'), 20, 101, 1010, null, 'a', 1010);
  insert.run(3, timestamp('2026-07-01T01:00:00Z'), 30, 102, 1020, null, 'b', 1020);
  insert.run(4, timestamp('2026-07-01T02:00:00Z'), 40, 103, 1030, null, 'b', 1030);

  const rows = db.prepare(liveSummarySql('daily')).all(
    timestamp('2026-06-29T00:00:00Z'),
    timestamp('2026-07-02T00:00:00Z'),
    100,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1].period_key, '2026-07-01');
  assert.equal(rows[1].sample_count, 3);
  assert.equal(rows[1].stream_start, 1010);
  assert.equal(rows[1].stream_end, 1030);
  assert.equal(rows[1].primary_host, 'b');
});

test('live summary selects boundary values in one ranked scan', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_channel_snapshots(
    id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, listener_count INTEGER,
    total_member_count INTEGER,total_listens INTEGER,current_stream_count INTEGER,host_handle TEXT,
    validated_stream_count INTEGER
  )`);
  const insert = db.prepare('INSERT INTO sh_channel_snapshots VALUES(?,?,?,?,?,?,?,?)');
  insert.run(1, 1000, 1, null, null, null, 'a', null);
  insert.run(2, 2000, 2, 100, 10, null, 'a', 10);
  insert.run(3, 2000, 3, 101, 11, null, 'a', 11);
  insert.run(4, 3000, 4, 110, 20, null, 'b', 20);

  const sql = liveSummarySql('daily');
  assert.doesNotMatch(sql, /SELECT stream_value FROM prepared/);
  assert.doesNotMatch(sql, /SELECT total_member_count FROM prepared/);
  const row = db.prepare(sql).get(0, 86400000, 10);
  assert.equal(row.stream_start, 10);
  assert.equal(row.stream_end, 20);
  assert.equal(row.member_start, 100);
  assert.equal(row.member_end, 110);
});

test('broadcast summary returns minimum listener without a second series query', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_legacy_snapshots(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_key TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL, source_row INTEGER NOT NULL,
    observed_at INTEGER NOT NULL, observed_jst TEXT, listener_count INTEGER,
    total_stream_count INTEGER, track_title TEXT, artist_name TEXT, likes INTEGER,
    comment_velocity REAL, host_handle TEXT, total_member_count INTEGER, source_note TEXT,
    quality_score REAL NOT NULL, quality_flags TEXT NOT NULL, raw_json TEXT NOT NULL,
    imported_at INTEGER NOT NULL
  )`);
  db.exec(legacyHistoryMigration);
  const insert = db.prepare(`INSERT INTO sh_legacy_snapshots(
    canonical_key,source_id,source_row,observed_at,observed_jst,listener_count,
    track_title,likes,host_handle,source_note,quality_score,quality_flags,raw_json,imported_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,1,'[]','{}',0)`);
  insert.run('k1', 's', 1, 1000, '2026-01-01 00:00', 30, 'A', 1, 'sakurazaka46jp', 'event');
  insert.run('k2', 's', 2, 2000, '2026-01-01 00:01', 12, 'B', 2, 'sakurazaka46jp', 'event');
  insert.run('k3', 's', 3, 3000, '2026-01-01 00:02', 20, 'A', 3, 'sakurazaka46jp', 'event');

  const rows = db.prepare(BROADCAST_SUMMARY_SQL).all(0, 4000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].listener_min, 12);
  assert.equal(rows[0].listener_max, 30);
  assert.equal(rows[0].distinct_tracks, 2);
});

test('summary overlay combines only incremental samples', () => {
  const merged = combineSummaryRows(
    { sample_count: 2, reliable_sample_count: 2, listener_avg: 10, listener_min: 5, listener_max: 15,
      stream_start: 100, stream_end: 110, member_start: 20, member_end: 22, period_start: 1, period_end: 2, primary_host: 'a' },
    { sample_count: 2, reliable_sample_count: 2, listener_avg: 20, listener_min: 18, listener_max: 22,
      stream_start: 111, stream_end: 120, member_start: 23, member_end: 25, period_start: 3, period_end: 4, primary_host: 'b' },
  );
  assert.equal(merged.sample_count, 4);
  assert.equal(merged.listener_avg, 15);
  assert.equal(merged.stream_growth, 20);
});

test('queue like observations are planned from one batched latest-row lookup', () => {
  const now = 10_000_000;
  const tracks = [
    { queue_track_id: 1, bite_count: 5, position: 0 },
    { queue_track_id: 2, bite_count: 7, position: 1 },
    { queue_track_id: 2, bite_count: 7, position: 1 },
  ];
  const planned = planLikeObservations(tracks, [
    { track_key: '1', like_count: 5, observed_at: now - 1000 },
    { track_key: '2', like_count: 6, observed_at: now - 1000 },
  ], now);
  assert.deepEqual(planned.map((item) => item.trackKey), ['2']);
  assert.match(latestLikesSql(2), /IN \(\?,\?\)/);
});

test('listener aggregates can be updated from the replaced minute delta', () => {
  assert.deepEqual(listenerAggregateDelta(null, 10), { sum: 10, count: 1 });
  assert.deepEqual(listenerAggregateDelta(10, 12), { sum: 2, count: 0 });
  assert.deepEqual(listenerAggregateDelta(10, null), { sum: -10, count: -1 });
});

test('concurrent dashboard prediction requests keep D1 work request-scoped', async () => {
  resetPredictionCache();
  let calls = 0;
  const statement = { first: async () => { calls += 1; return { sample_count: 1 }; } };
  const [first, second] = await Promise.all([
    cachedPrediction(statement),
    cachedPrediction(statement),
  ]);
  assert.equal(calls, 2);
  assert.deepEqual(first, second);
  await cachedPrediction(statement);
  assert.equal(calls, 2);
});
