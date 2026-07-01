import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  LATEST_QUEUE_WITH_ITEMS_SQL,
  parseLatestQueueRows,
} from '../site/functions/lib/latest-queue.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_channel_snapshots (
      id INTEGER PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      station_id INTEGER
    );
    CREATE TABLE sh_queue_snapshots (
      id INTEGER PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      station_id INTEGER,
      queue_id INTEGER,
      start_time INTEGER,
      is_paused INTEGER
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
      bite_count INTEGER
    );
    CREATE TABLE sh_track_metadata (
      spotify_id TEXT PRIMARY KEY,
      title TEXT,
      artist TEXT,
      display_title TEXT,
      thumbnail_url TEXT,
      spotify_url TEXT,
      fetched_at INTEGER,
      raw_json TEXT
    );
  `);
  return db;
}

test('latest queue is scoped to the station in the latest channel snapshot', () => {
  const db = database();
  db.exec(`
    INSERT INTO sh_channel_snapshots VALUES (1, 1000, 10);
    INSERT INTO sh_channel_snapshots VALUES (2, 2000, 20);

    INSERT INTO sh_queue_snapshots VALUES (1, 5000, 10, 101, 10000, 0);
    INSERT INTO sh_queue_snapshots VALUES (2, 3000, 20, 202, 20000, 0);

    INSERT INTO sh_queue_items (
      id,observed_at,station_id,queue_id,start_time,position,queue_track_id,spotify_id,duration_ms
    ) VALUES (1,3000,20,202,20000,0,1,'spotify-current',180000);
    INSERT INTO sh_queue_items (
      id,observed_at,station_id,queue_id,start_time,position,queue_track_id,spotify_id,duration_ms
    ) VALUES (2,5000,10,101,10000,0,2,'spotify-wrong-station',180000);
  `);

  const parsed = parseLatestQueueRows(db.prepare(LATEST_QUEUE_WITH_ITEMS_SQL).all());

  assert.equal(parsed.latestQueue.station_id, 20);
  assert.equal(parsed.latestQueue.queue_id, 202);
  assert.deepEqual(parsed.queue.map((row) => row.spotify_id), ['spotify-current']);
});

test('empty queue rows are parsed without phantom tracks', () => {
  assert.deepEqual(parseLatestQueueRows([]), { latestQueue: null, queue: [] });
});
