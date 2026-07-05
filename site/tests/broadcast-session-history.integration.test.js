import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  BROADCAST_SESSION_GAP_MS,
  broadcastSummarySql,
  parseBroadcastSummaryRows,
} from '../functions/api/history.js';

function createHistoryDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_legacy_history_rows (
    id INTEGER PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    observed_jst TEXT NOT NULL,
    listener_count INTEGER,
    total_stream_count INTEGER,
    track_title TEXT,
    artist_name TEXT,
    likes INTEGER,
    comment_velocity REAL,
    host_handle TEXT,
    total_member_count INTEGER,
    source_note TEXT,
    quality_score REAL,
    quality_flags TEXT
  )`);
  return db;
}

function insertRow(db, row) {
  db.prepare(`INSERT INTO sh_legacy_history_rows(
    id,observed_at,observed_jst,listener_count,track_title,artist_name,
    likes,host_handle,source_note
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    row.id,
    row.observed_at,
    new Date(row.observed_at).toISOString(),
    row.listener_count,
    row.track_title,
    row.artist_name,
    row.likes,
    row.host_handle,
    row.source_note,
  );
}

test('repeated event labels are split into time-separated broadcast sessions', () => {
  const db = createHistoryDatabase();
  const start = Date.parse('2025-01-01T00:00:00Z');
  insertRow(db, {
    id: 1,
    observed_at: start,
    listener_count: 100,
    track_title: 'Same title',
    artist_name: 'Artist A',
    likes: 10,
    host_handle: ' Sakurazaka46JP ',
    source_note: ' Repeat Event ',
  });
  insertRow(db, {
    id: 2,
    observed_at: start + 60_000,
    listener_count: 120,
    track_title: 'Same title',
    artist_name: 'Artist B',
    likes: 12,
    host_handle: 'sakurazaka46jp',
    source_note: 'Repeat Event',
  });
  const secondStart = start + BROADCAST_SESSION_GAP_MS + 120_000;
  insertRow(db, {
    id: 3,
    observed_at: secondStart,
    listener_count: 200,
    track_title: 'Third song',
    artist_name: 'Artist C',
    likes: 20,
    host_handle: 'SAKURAZAKA46JP',
    source_note: 'repeat event',
  });
  insertRow(db, {
    id: 4,
    observed_at: secondStart + 60_000,
    listener_count: 220,
    track_title: 'Third song',
    artist_name: 'Artist C',
    likes: 25,
    host_handle: 'sakurazaka46jp',
    source_note: 'Repeat Event',
  });
  insertRow(db, {
    id: 5,
    observed_at: secondStart + 120_000,
    listener_count: 999,
    track_title: 'Ignored',
    artist_name: 'Ignored',
    likes: 999,
    host_handle: 'sakurazaka46jp',
    source_note: '   ',
  });

  const rows = db.prepare(broadcastSummarySql('sh_legacy_history_rows')).all(
    start - 1,
    secondStart + 180_000,
    BROADCAST_SESSION_GAP_MS,
  );
  const parsed = parseBroadcastSummaryRows(rows);

  assert.equal(parsed.setupRequired, false);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].started_at, start);
  assert.equal(parsed.rows[0].ended_at, start + 60_000);
  assert.equal(parsed.rows[0].sample_count, 2);
  assert.equal(parsed.rows[0].listener_avg, 110);
  assert.equal(parsed.rows[0].likes_max, 12);
  assert.equal(parsed.rows[0].distinct_tracks, 2);
  assert.equal(parsed.rows[1].started_at, secondStart);
  assert.equal(parsed.rows[1].sample_count, 2);
  assert.equal(parsed.rows[1].distinct_tracks, 1);
});

test('an empty requested range reports existing setup without inventing a broadcast', () => {
  const db = createHistoryDatabase();
  const start = Date.parse('2025-01-01T00:00:00Z');
  insertRow(db, {
    id: 1,
    observed_at: start,
    listener_count: 100,
    track_title: 'Song',
    artist_name: 'Artist',
    likes: 10,
    host_handle: 'sakurazaka46jp',
    source_note: 'Existing Event',
  });

  const rows = db.prepare(broadcastSummarySql('sh_legacy_history_rows')).all(
    start + 86_400_000,
    start + 2 * 86_400_000,
    BROADCAST_SESSION_GAP_MS,
  );
  const parsed = parseBroadcastSummaryRows(rows);

  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.setupRequired, false);
});
