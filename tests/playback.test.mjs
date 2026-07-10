import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { PLAYBACK_FEED_SQL, parsePlaybackFeedRows } from '../site/functions/api/playback.js';
import { computePlayback } from '../site/functions/lib/playback.js';

test('computePlayback returns current track progress and anchors', () => {
  const queue = [
    { start_time: 1_000, duration_ms: 10_000 },
    { start_time: 1_000, duration_ms: 20_000 },
  ];

  const playback = computePlayback(queue, 16_000);

  assert.equal(playback.currentIndex, 1);
  assert.equal(playback.progressMs, 5_000);
  assert.equal(playback.anchorAt, 11_000);
  assert.equal(playback.queueEndAt, 31_000);
});

test('computePlayback clamps to the last track when elapsed exceeds queue duration', () => {
  const queue = [
    { start_time: 1_000, duration_ms: 10_000 },
    { start_time: 1_000, duration_ms: 20_000 },
  ];

  const playback = computePlayback(queue, 40_000);

  assert.equal(playback.currentIndex, 1);
  assert.equal(playback.progressMs, 20_000);
  assert.equal(playback.anchorAt, 11_000);
  assert.equal(playback.queueEndAt, 31_000);
});

test('playback feed obtains the latest channel and its queue in one query', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_channel_snapshots (
      id INTEGER PRIMARY KEY,observed_at INTEGER,station_id INTEGER,is_broadcasting INTEGER,
      host_account_id INTEGER,host_handle TEXT,broadcast_start_time INTEGER
    );
    CREATE TABLE sh_queue_current (
      station_id INTEGER PRIMARY KEY,queue_id INTEGER,start_time INTEGER,
      structural_hash TEXT NOT NULL,likes_hash TEXT,is_paused INTEGER,
      observed_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    );
    CREATE TABLE sh_queue_items (
      id INTEGER PRIMARY KEY,observed_at INTEGER,station_id INTEGER,queue_id INTEGER,
      start_time INTEGER,position INTEGER,queue_track_id INTEGER,stationhead_track_id INTEGER,
      spotify_id TEXT,apple_music_id TEXT,deezer_id TEXT,isrc TEXT,duration_ms INTEGER,
      preview_url TEXT,bite_count INTEGER
    );
    CREATE TABLE sh_track_metadata (
      spotify_id TEXT PRIMARY KEY,title TEXT,artist TEXT,display_title TEXT,
      thumbnail_url TEXT,spotify_url TEXT,fetched_at INTEGER,raw_json TEXT
    );
    INSERT INTO sh_channel_snapshots VALUES (1,1000,10,1,1,'old',500);
    INSERT INTO sh_channel_snapshots VALUES (2,2000,20,1,2,'current',1500);
    INSERT INTO sh_queue_current (station_id,queue_id,start_time,structural_hash,is_paused,observed_at,updated_at)
      VALUES (10,101,10000,'hash-10',0,3000,3000);
    INSERT INTO sh_queue_current (station_id,queue_id,start_time,structural_hash,is_paused,observed_at,updated_at)
      VALUES (20,202,20000,'hash-20',0,2500,2500);
    INSERT INTO sh_queue_items (
      id,observed_at,station_id,queue_id,start_time,position,queue_track_id,
      spotify_id,duration_ms
    ) VALUES (1,2500,20,202,20000,0,1,'spotify-current',180000);
    INSERT INTO sh_queue_items (
      id,observed_at,station_id,queue_id,start_time,position,queue_track_id,
      spotify_id,duration_ms
    ) VALUES (2,3000,10,101,10000,0,2,'spotify-wrong',180000);
  `);

  const parsed = parsePlaybackFeedRows(db.prepare(PLAYBACK_FEED_SQL).all());
  assert.equal(parsed.latest.station_id, 20);
  assert.equal(parsed.latest.host_handle, 'current');
  assert.equal(parsed.latestQueue.queue_id, 202);
  assert.deepEqual(parsed.queue.map((row) => row.spotify_id), ['spotify-current']);
});
