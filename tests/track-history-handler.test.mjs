import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  TRACK_HISTORY_GRACE_MS,
  TRACK_HISTORY_SQL,
} from '../site/functions/lib/track-history-handler.js';
import { mergeTrackRows } from '../site/functions/lib/track-history-merge.js';

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
      UNIQUE(station_id, start_time, position)
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

function addTracks(db, {
  start,
  count,
  duration = 180000,
  observed = start,
  station = 1,
  spotifyId = (position) => `spotify-${station}-${position}`,
  rawTitle = (position) => `Track ${position}`,
}) {
  const insert = db.prepare(`
    INSERT INTO sh_queue_items (
      observed_at, station_id, queue_id, start_time, position,
      queue_track_id, spotify_id, duration_ms, raw_json
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
  `);
  for (let position = 0; position < count; position += 1) {
    const durationMs = Array.isArray(duration) ? duration[position] : duration;
    insert.run(
      observed,
      station,
      start,
      position,
      position + 1,
      spotifyId(position),
      durationMs,
      JSON.stringify({ title: rawTitle(position), artist: 'Artist' }),
    );
  }
}

function addSnapshot(db, {
  start,
  observed,
  paused = 0,
  station = 1,
}) {
  db.prepare(`
    INSERT INTO sh_queue_snapshots (
      observed_at, station_id, queue_id, start_time, is_paused, raw_json
    ) VALUES (?, ?, 1, ?, ?, '{}')
  `).run(observed, station, start, paused);
}

function addChannelSnapshot(db, observed, {
  station = 1,
  launched = 1,
  broadcasting = 1,
} = {}) {
  db.prepare(`INSERT INTO sh_channel_snapshots (
    observed_at,station_id,is_launched,is_broadcasting
  ) VALUES (?,?,?,?)`).run(observed, station, launched, broadcasting);
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

test('does not count the entire future queue as already played', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  addTracks(db, { start, count: 2000 });
  addSnapshot(db, { start, observed: start + 30 * 60000 });

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.equal(rows.length, 12);
  assert.ok(rows.length < 2000);
});

test('includes a long-running queue that started more than seven days earlier', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-01T00:00:00Z');
  addTracks(db, { start, count: 600, duration: 3600000 });
  addSnapshot(db, {
    start,
    observed: Date.parse('2026-06-20T02:00:00Z'),
  });

  const rows = queryTracks(db, '2026-06-20', '2026-06-20');

  assert.equal(rows.length, 3);
  assert.equal(rows[0].position, 456);
});

test('uses UTC day boundaries, which begin at 09:00 in Japan', () => {
  const db = createDatabase();
  const before = Date.parse('2026-06-30T23:59:00Z');
  const boundary = Date.parse('2026-07-01T00:00:00Z');
  addTracks(db, { start: before, count: 1, station: 1 });
  addSnapshot(db, { start: before, observed: before, station: 1 });
  addTracks(db, { start: boundary, count: 1, station: 2 });
  addSnapshot(db, { start: boundary, observed: boundary, station: 2 });

  const rows = queryTracks(db, '2026-07-01', '2026-07-01');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].play_date, '2026-07-01');
  assert.equal(rows[0].spotify_id, 'spotify-2-0');
  assert.equal(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(rows[0].played_at)),
    '2026-07-01 09:00',
  );
});

test('maps tracks after a pause to their real UTC playback day', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T23:50:00Z');
  addTracks(db, { start, count: 6, duration: 5 * 60_000 });
  addSnapshot(db, { start, observed: start });
  addSnapshot(db, { start, observed: Date.parse('2026-06-30T23:55:00Z'), paused: 1 });
  addSnapshot(db, { start, observed: Date.parse('2026-07-01T00:10:00Z'), paused: 0 });
  addChannelSnapshot(db, Date.parse('2026-07-01T00:20:00Z'));

  const rows = queryTracks(db, '2026-07-01', '2026-07-01');

  assert.deepEqual(rows.map((row) => row.position), [1, 2, 3, 4]);
  assert.equal(rows[0].played_at, Date.parse('2026-07-01T00:10:00Z'));
  assert.ok(rows.every((row) => row.play_date === '2026-07-01'));
});

test('includes collection coverage for each UTC playback day', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  addTracks(db, { start, count: 2 });
  addSnapshot(db, { start, observed: start + 10 * 60000 });
  addChannelSnapshot(db, start + 5 * 60000);
  addChannelSnapshot(db, start + 23 * 3600000 + 55 * 60000);

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.equal(rows[0].period_first_observed_at, start + 5 * 60000);
  assert.equal(rows[0].period_last_observed_at, start + 23 * 3600000 + 55 * 60000);
});

test('stops inferring later playback after an invalid duration', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  addTracks(db, {
    start,
    count: 4,
    duration: [180000, null, 180000, 180000],
  });
  addSnapshot(db, { start, observed: start + 3600000 });

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.deepEqual(rows.map((row) => row.position), [0, 1]);
});

test('counts playback until a pause begins but adds no grace while paused', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  addTracks(db, { start, count: 200, duration: 120000 });
  addSnapshot(db, { start, observed: start + 10 * 60000 });
  addSnapshot(db, { start, observed: start + 3 * 3600000, paused: 1 });
  addChannelSnapshot(db, start + 4 * 3600000);

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.equal(rows.length, 90);
  assert.equal(rows.at(-1).position, 89);
});

test('subtracts a paused interval and maps resumed tracks to wall-clock time', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  addTracks(db, { start, count: 100, duration: 120000 });
  addSnapshot(db, { start, observed: start + 60_000 });
  addSnapshot(db, { start, observed: start + 10 * 60_000, paused: 1 });
  addSnapshot(db, { start, observed: start + 20 * 60_000, paused: 0 });
  addChannelSnapshot(db, start + 30 * 60_000);

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.equal(rows.length, 13);
  assert.equal(rows[5].position, 5);
  assert.equal(rows[5].played_at, start + 20 * 60_000);
  assert.equal(rows.at(-1).position, 12);
  assert.equal(rows.at(-1).played_at, start + 34 * 60_000);
});

test('uses queue item heartbeat evidence for legacy rows without snapshots', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  addTracks(db, {
    start,
    count: 20,
    duration: 180000,
    observed: start + 15 * 60000,
  });

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.equal(rows.length, 7);
});

test('preaggregates repeated plays before rows leave SQLite', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  addTracks(db, {
    start,
    count: 4,
    spotifyId: () => 'same-track',
    rawTitle: () => 'Same Track',
  });
  addSnapshot(db, { start, observed: start + 20 * 60000 });

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].play_count, 4);
  assert.equal(rows[0].first_played_at, start);
  assert.equal(rows[0].last_played_at, start + 9 * 60000);
});

test('mergeTrackRows adds preaggregated counts for matching titles', () => {
  const rows = mergeTrackRows([
    {
      play_date: '2026-06-30', title: 'Song', artist: 'Artist', spotify_id: 'a',
      play_count: 3, first_played_at: 10, last_played_at: 30,
    },
    {
      play_date: '2026-06-30', title: 'Song', artist: 'Artist', spotify_id: 'b',
      play_count: 2, first_played_at: 40, last_played_at: 50,
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].play_count, 5);
  assert.equal(rows[0].first_played_at, 10);
  assert.equal(rows[0].last_played_at, 50);
});
