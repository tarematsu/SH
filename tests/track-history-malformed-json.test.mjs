import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  TRACK_HISTORY_GRACE_MS,
  TRACK_HISTORY_SQL,
} from '../site/functions/lib/track-history-handler.js';

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_queue_snapshots (
      id INTEGER PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      station_id INTEGER,
      queue_id INTEGER,
      start_time INTEGER,
      is_paused INTEGER,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE sh_queue_items (
      id INTEGER PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      station_id INTEGER NOT NULL,
      queue_id INTEGER,
      start_time INTEGER NOT NULL,
      position INTEGER NOT NULL,
      queue_track_id INTEGER,
      stationhead_track_id INTEGER,
      spotify_id TEXT,
      apple_music_id TEXT,
      deezer_id TEXT,
      isrc TEXT,
      duration_ms INTEGER,
      preview_url TEXT,
      bite_count INTEGER,
      raw_json TEXT NOT NULL,
      UNIQUE(station_id,start_time,position)
    );
    CREATE TABLE sh_track_metadata (
      spotify_id TEXT PRIMARY KEY,
      title TEXT,
      artist TEXT,
      display_title TEXT,
      thumbnail_url TEXT,
      spotify_url TEXT,
      source TEXT,
      fetched_at INTEGER,
      raw_json TEXT
    );
    CREATE TABLE sh_channel_snapshots (
      id INTEGER PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      station_id INTEGER,
      is_launched INTEGER,
      is_broadcasting INTEGER
    );
  `);
  return db;
}

function queryTracks(db, from, to) {
  const fromTs = Date.parse(`${from}T00:00:00Z`);
  const toTs = Date.parse(`${to}T00:00:00Z`) + 86400000;
  return db.prepare(TRACK_HISTORY_SQL).all(
    toTs,
    fromTs - TRACK_HISTORY_GRACE_MS, toTs,
    fromTs - TRACK_HISTORY_GRACE_MS, toTs,
    fromTs - TRACK_HISTORY_GRACE_MS, toTs,
    toTs,
    TRACK_HISTORY_GRACE_MS,
    fromTs, toTs,
    fromTs, toTs,
    100,
  );
}

test('malformed legacy queue metadata does not erase otherwise valid history', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  db.prepare(`INSERT INTO sh_queue_items (
    observed_at,station_id,queue_id,start_time,position,queue_track_id,
    spotify_id,duration_ms,raw_json
  ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    start,
    1,
    1,
    start,
    0,
    1,
    'spotify-malformed',
    180000,
    '{broken-json',
  );
  db.prepare(`INSERT INTO sh_queue_snapshots (
    observed_at,station_id,queue_id,start_time,is_paused,raw_json
  ) VALUES (?,?,?,?,?,?)`).run(start + 10 * 60_000, 1, 1, start, 0, '{}');

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].spotify_id, 'spotify-malformed');
  assert.equal(rows[0].raw_title, null);
  assert.equal(rows[0].raw_artist, null);
});
