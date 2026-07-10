import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  TRACK_LIKE_REALTIME_SQL,
  TRACK_LIKE_QUEUE_SQL,
  compactTrackLikeRows,
  compactTrackLikeSources,
  attachCompactTrackLikes,
  attachTrackLikes,
} from '../site/functions/lib/track-likes.js';

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_track_like_observations (
      id INTEGER PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      spotify_id TEXT,
      apple_music_id TEXT,
      isrc TEXT,
      stationhead_track_id INTEGER,
      queue_track_id INTEGER,
      track_key TEXT,
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

test('like queries keep the latest observation for each UTC day and ISRC', () => {
  const db = createDatabase();
  db.prepare('INSERT INTO sh_track_like_observations VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(1, 1000, 'spotify-1', null, 'jpabc1234567', 1, 10, 'legacy-key', 3, 'collector');
  db.prepare('INSERT INTO sh_track_like_observations VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(2, 2000, 'spotify-2', null, 'JPABC1234567', 2, 20, 'isrc:JPABC1234567', 5, 'collector');
  db.prepare('INSERT INTO sh_track_like_observations VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(3, 3000, 'spotify-no-isrc', null, null, 3, 30, 'spotify:spotify-no-isrc', 99, 'collector');
  db.prepare('INSERT INTO sh_track_metadata VALUES(?,?,?)').run('spotify-1', 'Song', 'Artist');
  db.prepare('INSERT INTO sh_queue_items VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(1, 500, 3000, 0, 'spotify-1', null, 'jpabc1234567', 1, 10, 7);
  db.prepare('INSERT INTO sh_queue_items VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(2, 500, 4000, 1, 'spotify-no-isrc', null, null, 2, 20, 88);

  const realtime = db.prepare(TRACK_LIKE_REALTIME_SQL).all(0, 86400000);
  const queue = db.prepare(TRACK_LIKE_QUEUE_SQL).all(0, 86400000);

  assert.equal(realtime.length, 1);
  assert.equal(realtime[0].like_count, 5);
  assert.equal(realtime[0].isrc, 'JPABC1234567');
  assert.equal(queue.length, 1);
  assert.equal(queue[0].like_count, 7);
});

test('compaction ignores rows without ISRC', () => {
  const rows = compactTrackLikeSources([
    [{ play_date: '1970-01-01', isrc: 'jpabc1234567', like_count: 3, observed_at: 1000 }],
    [{ play_date: '1970-01-01', isrc: 'JPABC1234567', like_count: 5, observed_at: 2000 }],
    [{ play_date: '1970-01-01', spotify_id: 'spotify-1', like_count: 99, observed_at: 3000 }],
    [{ play_date: '1970-01-01', title: 'Legacy', artist: 'Artist', like_count: 88, observed_at: 4000 }],
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].like_count, 5);
  assert.equal(rows[0].isrc, 'JPABC1234567');
});

test('track rows receive external likes only through matching ISRC', () => {
  const compactRows = compactTrackLikeRows([
    { play_date: '1970-01-01', isrc: 'jpabc1234567', like_count: 5, observed_at: 2000 },
    { play_date: '1970-01-01', isrc: 'JPABC1234567', like_count: 7, observed_at: 3000 },
    { play_date: '1970-01-01', spotify_id: 'spotify-2', like_count: 90, observed_at: 4000 },
  ]);
  const tracks = [
    {
      play_date: '1970-01-01',
      title: 'Song',
      artist: 'Artist',
      spotify_id: 'spotify-1',
      isrc: 'JPABC1234567',
      like_count: 3,
    },
    {
      play_date: '1970-01-01',
      title: 'No ISRC',
      artist: 'Artist',
      spotify_id: 'spotify-2',
      like_count: 4,
    },
  ];
  const directRows = attachCompactTrackLikes(tracks, compactRows);
  const compatibilityRows = attachTrackLikes(tracks, compactRows);

  assert.equal(directRows[0].like_count, 7);
  assert.equal(directRows[1].like_count, 4);
  assert.deepEqual(directRows, compatibilityRows);
});

test('matching is case insensitive but different ISRC values never share likes', () => {
  const compactRows = compactTrackLikeRows([
    {
      play_date: '2026-07-01',
      isrc: 'jpabc1234567',
      like_count: 8,
      observed_at: 1000,
    },
  ]);
  const rows = attachCompactTrackLikes([
    {
      play_date: '2026-07-01',
      isrc: 'JPABC1234567',
      like_count: 3,
    },
    {
      play_date: '2026-07-01',
      isrc: 'JPABC7654321',
      like_count: 6,
    },
  ], compactRows);

  assert.equal(rows[0].like_count, 8);
  assert.equal(rows[1].like_count, 6);
});

test('Spotify, queue and Stationhead IDs are never used as like identities', () => {
  const compactRows = compactTrackLikeRows([
    {
      play_date: '2026-07-01',
      spotify_id: 'same',
      queue_track_id: 123,
      stationhead_track_id: 456,
      like_count: 9,
      observed_at: 1000,
    },
  ]);
  const [track] = attachCompactTrackLikes([
    {
      play_date: '2026-07-01',
      spotify_id: 'same',
      queue_track_id: 123,
      stationhead_track_id: 456,
      like_count: 2,
    },
  ], compactRows);

  assert.equal(compactRows.length, 0);
  assert.equal(track.like_count, 2);
});
