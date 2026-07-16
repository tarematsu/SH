import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  TRACK_LIKE_REALTIME_SQL,
  TRACK_LIKE_QUEUE_SQL,
  compactTrackLikeRows,
  compactTrackLikeSources,
  attachCompactTrackLikes,
  attachTrackLikes,
} from '../site/functions/lib/track-likes.js';

const canonicalTrackLikeMigration = readFileSync(
  new URL('../database/buddies-migrations/005_canonical_track_like_keys.sql', import.meta.url),
  'utf8',
);

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_track_like_observations (
      id INTEGER PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      station_id INTEGER,
      spotify_id TEXT,
      apple_music_id TEXT,
      isrc TEXT,
      stationhead_track_id INTEGER,
      queue_track_id INTEGER,
      track_key TEXT NOT NULL,
      like_count INTEGER,
      source TEXT
    );
    CREATE TABLE sh_queue_items (
      id INTEGER PRIMARY KEY,
      start_time INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      position INTEGER NOT NULL,
      spotify_id TEXT,
      apple_music_id TEXT,
      isrc TEXT,
      stationhead_track_id INTEGER,
      queue_track_id INTEGER,
      bite_count INTEGER
    );
    CREATE TABLE sh_track_metadata (
      spotify_id TEXT PRIMARY KEY,
      title TEXT,
      artist TEXT
    );
    CREATE TABLE sh_track_like_history (
      observed_at INTEGER NOT NULL,
      track_title TEXT,
      artist TEXT,
      like_count INTEGER
    );
  `);
  return db;
}

function insertObservation(db, values) {
  db.prepare('INSERT INTO sh_track_like_observations VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(...values);
}

test('like queries prefer canonical ISRC keys and use Spotify only when ISRC is missing', () => {
  const db = createDatabase();
  insertObservation(db, [1, 1000, 1, 'spotify-old', null, 'jpabc1234567', 1, 10, 'old-key', 3, 'collector']);
  insertObservation(db, [2, 2000, 1, 'spotify-new', null, 'JPABC1234567', 2, 20, 'isrc:JPABC1234567', 5, 'collector']);
  insertObservation(db, [3, 3000, 1, 'spotify-fallback', null, null, 3, 30, 'spotify:spotify-fallback', 7, 'collector']);
  insertObservation(db, [4, 4000, 1, 'spotify-fallback', null, '', 4, 40, 'spotify:spotify-fallback', 9, 'collector']);
  db.exec(canonicalTrackLikeMigration);

  db.prepare('INSERT INTO sh_track_metadata VALUES(?,?,?)').run('spotify-new', 'Song', 'Artist');
  db.prepare('INSERT INTO sh_queue_items VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(1, 500, 3000, 0, 'spotify-new', null, 'jpabc1234567', 1, 10, 11);
  db.prepare('INSERT INTO sh_queue_items VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(2, 500, 4000, 1, 'spotify-queue-fallback', null, null, 2, 20, 13);

  const realtime = db.prepare(TRACK_LIKE_REALTIME_SQL).all(0, 86400000);
  const queue = db.prepare(TRACK_LIKE_QUEUE_SQL).all(0, 86400000);

  assert.equal(realtime.length, 2);
  assert.equal(realtime.find((row) => row.isrc)?.like_count, 5);
  assert.equal(realtime.find((row) => !row.isrc)?.like_count, 9);
  assert.equal(queue.length, 2);
  assert.equal(queue.find((row) => row.isrc)?.like_count, 11);
  assert.equal(queue.find((row) => !row.isrc)?.like_count, 13);
  assert.match(TRACK_LIKE_REALTIME_SQL, /PARTITION BY play_date,track_key/);
  assert.doesNotMatch(TRACK_LIKE_REALTIME_SQL, /UPPER\(TRIM\(isrc\)\)/);
});

test('canonical migration deduplicates conflicting legacy keys before rewriting them', () => {
  const db = createDatabase();
  insertObservation(db, [1, 1000, 7, 'spotify-a', null, 'jpabc1234567', 1, 10, 'legacy-a', 3, 'collector']);
  insertObservation(db, [2, 1000, 7, 'spotify-b', null, 'JPABC1234567', 2, 20, 'legacy-b', 5, 'collector']);

  db.exec(canonicalTrackLikeMigration);
  const rows = db.prepare('SELECT id,track_key,like_count FROM sh_track_like_observations ORDER BY id').all();

  assert.deepEqual(rows, [{ id: 2, track_key: 'isrc:JPABC1234567', like_count: 5 }]);
});

test('compaction keeps ISRC identities and Spotify fallbacks separately', () => {
  const rows = compactTrackLikeSources([
    [{ play_date: '1970-01-01', spotify_id: 'spotify-a', isrc: 'jpabc1234567', like_count: 3, observed_at: 1000 }],
    [{ play_date: '1970-01-01', spotify_id: 'spotify-b', isrc: 'JPABC1234567', like_count: 5, observed_at: 2000 }],
    [{ play_date: '1970-01-01', spotify_id: 'spotify-fallback', like_count: 7, observed_at: 3000 }],
    [{ play_date: '1970-01-01', spotify_id: 'spotify-fallback', like_count: 9, observed_at: 4000 }],
    [{ play_date: '1970-01-01', title: 'Ignored', artist: 'Artist', like_count: 99, observed_at: 5000 }],
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.isrc)?.like_count, 5);
  assert.equal(rows.find((row) => !row.isrc)?.like_count, 9);
});

test('track rows receive likes by ISRC first and Spotify only without ISRC', () => {
  const compactRows = compactTrackLikeRows([
    { play_date: '1970-01-01', spotify_id: 'wrong-for-isrc', isrc: 'jpabc1234567', like_count: 7, observed_at: 3000 },
    { play_date: '1970-01-01', spotify_id: 'spotify-fallback', like_count: 9, observed_at: 4000 },
  ]);
  const tracks = [
    {
      play_date: '1970-01-01',
      title: 'ISRC Song',
      spotify_id: 'spotify-fallback',
      isrc: 'JPABC1234567',
      like_count: 3,
    },
    {
      play_date: '1970-01-01',
      title: 'Spotify Fallback Song',
      spotify_id: 'spotify-fallback',
      like_count: 4,
    },
  ];
  const directRows = attachCompactTrackLikes(tracks, compactRows);
  const compatibilityRows = attachTrackLikes(tracks, compactRows);

  assert.equal(directRows[0].like_count, 7);
  assert.equal(directRows[1].like_count, 9);
  assert.deepEqual(directRows, compatibilityRows);
});

test('Spotify cannot override a track that has a different ISRC', () => {
  const compactRows = compactTrackLikeRows([
    {
      play_date: '2026-07-01',
      spotify_id: 'same-spotify',
      isrc: 'JPABC1234567',
      like_count: 8,
      observed_at: 1000,
    },
    {
      play_date: '2026-07-01',
      spotify_id: 'same-spotify',
      like_count: 10,
      observed_at: 2000,
    },
  ]);
  const rows = attachCompactTrackLikes([
    {
      play_date: '2026-07-01',
      spotify_id: 'same-spotify',
      isrc: 'JPABC1234567',
      like_count: 1,
    },
    {
      play_date: '2026-07-01',
      spotify_id: 'same-spotify',
      isrc: 'JPABC7654321',
      like_count: 2,
    },
    {
      play_date: '2026-07-01',
      spotify_id: 'same-spotify',
      like_count: 3,
    },
  ], compactRows);

  assert.equal(rows[0].like_count, 8);
  assert.equal(rows[1].like_count, 2);
  assert.equal(rows[2].like_count, 10);
});

test('queue and Stationhead IDs are never used as like identities', () => {
  const compactRows = compactTrackLikeRows([
    {
      play_date: '2026-07-01',
      queue_track_id: 123,
      stationhead_track_id: 456,
      like_count: 9,
      observed_at: 1000,
    },
  ]);
  const [track] = attachCompactTrackLikes([
    {
      play_date: '2026-07-01',
      queue_track_id: 123,
      stationhead_track_id: 456,
      like_count: 2,
    },
  ], compactRows);

  assert.equal(compactRows.length, 0);
  assert.equal(track.like_count, 2);
});
