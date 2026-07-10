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

function addTracks(db, { start, count, duration = 180000, station = 1 }) {
  const insert = db.prepare(`
    INSERT INTO sh_queue_items (
      observed_at,station_id,queue_id,start_time,position,
      queue_track_id,spotify_id,duration_ms,raw_json
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
  `);
  for (let position = 0; position < count; position += 1) {
    insert.run(
      start,
      station,
      start,
      position,
      position + 1,
      `spotify-${station}-${start}-${position}`,
      duration,
      JSON.stringify({ title: `Track ${position}`, artist: 'Artist' }),
    );
  }
}

function addQueueSnapshot(db, { start, observed, paused = 0, station = 1 }) {
  db.prepare(`
    INSERT INTO sh_queue_snapshots (
      observed_at,station_id,queue_id,start_time,is_paused,raw_json
    ) VALUES (?, ?, 1, ?, ?, '{}')
  `).run(observed, station, start, paused);
}

function addChannelSnapshot(db, {
  observed,
  station = 1,
  launched = 1,
  broadcasting = 1,
}) {
  db.prepare(`
    INSERT INTO sh_channel_snapshots (
      observed_at,station_id,is_launched,is_broadcasting
    ) VALUES (?, ?, ?, ?)
  `).run(observed, station, launched, broadcasting);
}

function queryTracks(db, from, to, limit = 100000) {
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
    limit,
  );
}

test('restores sparse historical queue reachability from channel snapshots', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  addTracks(db, { start, count: 20 });
  addQueueSnapshot(db, { start, observed: start + 60_000 });
  addChannelSnapshot(db, { observed: start + 30 * 60_000 });

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.equal(rows.length, 12);
  assert.equal(rows.at(-1).position, 11);
});

test('counts only active time before a queue remains paused', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  addTracks(db, { start, count: 20 });
  addQueueSnapshot(db, { start, observed: start + 60_000 });
  addQueueSnapshot(db, { start, observed: start + 10 * 60_000, paused: 1 });
  addChannelSnapshot(db, { observed: start + 30 * 60_000 });

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.deepEqual(rows.map((row) => row.position), [0, 1, 2, 3]);
});

test('does not use inactive channel observations as playback evidence', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  addTracks(db, { start, count: 20 });
  addQueueSnapshot(db, { start, observed: start + 60_000 });
  addChannelSnapshot(db, {
    observed: start + 30 * 60_000,
    launched: 0,
    broadcasting: 0,
  });

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.deepEqual(rows.map((row) => row.position), [0, 1, 2]);
});

test('stops old queue reconstruction at the next queue start', () => {
  const db = createDatabase();
  const first = Date.parse('2026-06-30T00:00:00Z');
  const second = first + 15 * 60_000;
  addTracks(db, { start: first, count: 20 });
  addQueueSnapshot(db, { start: first, observed: first + 60_000 });
  addTracks(db, { start: second, count: 2 });
  addQueueSnapshot(db, { start: second, observed: second + 60_000 });
  addChannelSnapshot(db, { observed: first + 30 * 60_000 });

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');
  const firstQueueRows = rows.filter((row) => String(row.spotify_id).includes(String(first)));

  assert.deepEqual(firstQueueRows.map((row) => row.position), [0, 1, 2]);
});
