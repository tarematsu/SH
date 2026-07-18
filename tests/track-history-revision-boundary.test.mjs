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

function addQueue(db, { start, tracks, evidenceAt = start, station = 1, queueId = start }) {
  const insert = db.prepare(`INSERT INTO sh_queue_items (
    observed_at,station_id,queue_id,start_time,position,queue_track_id,
    stationhead_track_id,spotify_id,isrc,duration_ms,raw_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  tracks.forEach((track, position) => insert.run(
    start,
    station,
    queueId,
    start,
    position,
    track.queueTrackId ?? position + 1,
    track.stationheadTrackId ?? null,
    track.spotifyId ?? null,
    track.isrc ?? null,
    track.duration,
    JSON.stringify({ title: track.title || track.spotifyId, artist: 'Artist' }),
  ));
  db.prepare(`INSERT INTO sh_queue_snapshots (
    observed_at,station_id,queue_id,start_time,is_paused,raw_json
  ) VALUES (?,?,?,?,0,'{}')`).run(evidenceAt, station, queueId, start);
}

function queryTracks(db, day) {
  const fromTs = Date.parse(`${day}T00:00:00Z`);
  const toTs = fromTs + 86400000;
  return db.prepare(TRACK_HISTORY_SQL).all(
    toTs,
    fromTs - TRACK_HISTORY_GRACE_MS, toTs,
    fromTs - TRACK_HISTORY_GRACE_MS, toTs,
    fromTs - TRACK_HISTORY_GRACE_MS, toTs,
    toTs,
    TRACK_HISTORY_GRACE_MS,
    fromTs, toTs,
    fromTs, toTs,
    1000,
  );
}

test('does not count a playing track again when the queue changes mid-song', () => {
  const db = createDatabase();
  const firstStart = Date.parse('2026-07-18T12:00:00Z');
  const secondStart = firstStart + 60_000;

  addQueue(db, {
    start: firstStart,
    tracks: [
      { spotifyId: 'song-a', queueTrackId: 101, duration: 3 * 60_000 },
      { spotifyId: 'removed-song', queueTrackId: 102, duration: 3 * 60_000 },
    ],
  });
  addQueue(db, {
    start: secondStart,
    evidenceAt: secondStart + 4 * 60_000,
    tracks: [
      { spotifyId: 'song-a', queueTrackId: 201, duration: 3 * 60_000 },
      { spotifyId: 'replacement-song', queueTrackId: 202, duration: 3 * 60_000 },
    ],
  });

  const rows = queryTracks(db, '2026-07-18');
  const counts = new Map(rows.map((row) => [row.spotify_id, row.play_count]));

  assert.equal(counts.get('song-a'), 1);
  assert.equal(counts.get('replacement-song'), 1);
  assert.equal(counts.has('removed-song'), false);
});

test('still counts the same song twice when the first play ended at the boundary', () => {
  const db = createDatabase();
  const firstStart = Date.parse('2026-07-18T12:00:00Z');
  const secondStart = firstStart + 60_000;

  addQueue(db, {
    start: firstStart,
    tracks: [{ spotifyId: 'song-a', queueTrackId: 101, duration: 60_000 }],
  });
  addQueue(db, {
    start: secondStart,
    tracks: [{ spotifyId: 'song-a', queueTrackId: 201, duration: 60_000 }],
  });

  const rows = queryTracks(db, '2026-07-18');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].spotify_id, 'song-a');
  assert.equal(rows[0].play_count, 2);
});
