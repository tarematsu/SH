import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  TRACK_HISTORY_GRACE_MS,
  TRACK_HISTORY_SQL,
  handleTrackHistory,
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

function addTracks(db, { start, count, duration, bites = () => null }) {
  const insert = db.prepare(`INSERT INTO sh_queue_items (
    observed_at,station_id,queue_id,start_time,position,queue_track_id,
    spotify_id,duration_ms,bite_count,raw_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (let position = 0; position < count; position += 1) {
    insert.run(
      start,
      1,
      1,
      start,
      position,
      position + 1,
      `spotify-${position}`,
      duration,
      bites(position),
      JSON.stringify({ title: `Track ${position}`, artist: 'Artist' }),
    );
  }
}

function addQueueSnapshot(db, start, observed, paused) {
  db.prepare(`INSERT INTO sh_queue_snapshots (
    observed_at,station_id,queue_id,start_time,is_paused,raw_json
  ) VALUES (?,?,?,?,?,?)`).run(observed, 1, 1, start, paused, '{}');
}

function addChannelSnapshot(db, observed) {
  db.prepare(`INSERT INTO sh_channel_snapshots (
    observed_at,station_id,is_launched,is_broadcasting
  ) VALUES (?,?,?,?)`).run(observed, 1, 1, 1);
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
    1000,
  );
}

test('a pause event at evidence_end receives no active grace', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T00:00:00Z');
  addTracks(db, { start, count: 20, duration: 2 * 60_000 });
  addQueueSnapshot(db, start, start, 0);
  addQueueSnapshot(db, start, start + 10 * 60_000, 1);

  const rows = queryTracks(db, '2026-06-30', '2026-06-30');

  assert.deepEqual(rows.map((row) => row.position), [0, 1, 2, 3, 4]);
});

test('queue fallback likes follow the reconstructed play date after a pause', () => {
  const db = createDatabase();
  const start = Date.parse('2026-06-30T23:50:00Z');
  addTracks(db, {
    start,
    count: 4,
    duration: 5 * 60_000,
    bites: (position) => position === 1 ? 7 : position,
  });
  addQueueSnapshot(db, start, start, 0);
  addQueueSnapshot(db, start, Date.parse('2026-06-30T23:55:00Z'), 1);
  addQueueSnapshot(db, start, Date.parse('2026-07-01T00:10:00Z'), 0);
  addChannelSnapshot(db, Date.parse('2026-07-01T00:20:00Z'));

  const rows = queryTracks(db, '2026-07-01', '2026-07-01');
  const resumedTrack = rows.find((row) => row.position === 1);

  assert.equal(resumedTrack.play_date, '2026-07-01');
  assert.equal(resumedTrack.like_count, 7);
});

test('merged aliases retain namespaced source keys and the highest queue like count', () => {
  const [row] = mergeTrackRows([
    {
      play_date: '2026-07-01',
      title: 'Song',
      artist: 'Artist',
      spotify_id: '123',
      like_count: 3,
      play_count: 1,
      played_at: 10,
    },
    {
      play_date: '2026-07-01',
      title: 'Song',
      artist: 'Artist',
      spotify_id: '456',
      queue_track_id: 123,
      like_count: 8,
      play_count: 1,
      played_at: 20,
    },
  ]);

  assert.equal(row.like_count, 8);
  assert.ok(row.source_keys.includes('spotify:123'));
  assert.ok(row.source_keys.includes('spotify:456'));
  assert.ok(row.source_keys.includes('queue:123'));
});

test('impossible and empty date parameters return 400 before querying D1', async () => {
  const env = {
    DB: {
      prepare() {
        throw new Error('D1 should not be queried');
      },
    },
  };

  for (const query of [
    'from=2026-02-31&to=2026-03-01',
    'from=&to=2026-03-01',
  ]) {
    const response = await handleTrackHistory({
      request: new Request(`https://example.test/api/track-history?${query}`),
      env,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'invalid date range' });
  }
});
