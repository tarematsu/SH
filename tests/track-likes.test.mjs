import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  TRACK_LIKE_REALTIME_SQL,
  TRACK_LIKE_QUEUE_SQL,
  TRACK_LIKE_HISTORY_SQL,
  compactTrackLikeRows,
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

test('like queries return only the latest observation for each UTC day and track', () => {
  const db = createDatabase();
  db.prepare('INSERT INTO sh_track_like_observations VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(1, 1000, 'spotify-1', null, null, null, null, 'spotify-1', 3, 'collector');
  db.prepare('INSERT INTO sh_track_like_observations VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(2, 2000, 'spotify-1', null, null, null, null, 'spotify-1', 5, 'collector');
  db.prepare('INSERT INTO sh_track_metadata VALUES(?,?,?)').run('spotify-1', 'Song', 'Artist');
  db.prepare('INSERT INTO sh_queue_items VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(1, 500, 3000, 0, 'spotify-1', null, null, null, 10, 7);
  db.prepare('INSERT INTO sh_track_like_history VALUES(?,?,?,?)').run(1000, 'Legacy', 'Artist', 2);
  db.prepare('INSERT INTO sh_track_like_history VALUES(?,?,?,?)').run(4000, 'Legacy', 'Artist', 4);

  const realtime = db.prepare(TRACK_LIKE_REALTIME_SQL).all(0, 86400000);
  const queue = db.prepare(TRACK_LIKE_QUEUE_SQL).all(0, 86400000);
  const historical = db.prepare(TRACK_LIKE_HISTORY_SQL).all(0, 86400000);

  assert.equal(realtime.length, 1);
  assert.equal(realtime[0].like_count, 5);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].like_count, 7);
  assert.equal(historical.length, 1);
  assert.equal(historical[0].like_count, 4);
});

test('track rows receive the newest compatible like value without a second browser request', () => {
  const likeRows = compactTrackLikeRows([
    { play_date: '1970-01-01', spotify_id: 'spotify-1', like_count: 5, observed_at: 2000 },
    { play_date: '1970-01-01', spotify_id: 'spotify-1', like_count: 7, observed_at: 3000 },
    { play_date: '1970-01-01', title: 'Legacy', artist: 'Artist', like_count: 4, observed_at: 4000 },
  ]);
  const rows = attachTrackLikes([
    { play_date: '1970-01-01', title: 'Song', artist: 'Artist', source_ids: ['spotify-1'] },
    { play_date: '1970-01-01', title: 'Legacy', artist: 'Artist', source_ids: [] },
  ], likeRows);

  assert.equal(rows[0].like_count, 7);
  assert.equal(rows[1].like_count, 4);
});
