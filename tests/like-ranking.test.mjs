import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { likeRankingSql } from '../site/functions/api/like-ranking.js';

function rankingDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_tracks (
      id INTEGER PRIMARY KEY,
      isrc TEXT UNIQUE,
      spotify_id TEXT UNIQUE,
      title TEXT,
      artist TEXT
    );
    CREATE TABLE sh_track_counter_current (
      occurrence_key TEXT PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      count_value INTEGER NOT NULL,
      track_key TEXT NOT NULL,
      track_id INTEGER,
      isrc TEXT,
      spotify_id TEXT
    );
    INSERT INTO sh_tracks VALUES
      (1,'ISRC-A','spotify-a','Song A','Artist A'),
      (2,'ISRC-B','spotify-b','Song B','Artist B');
    INSERT INTO sh_track_counter_current VALUES
      ('a:old-high',500,100,'a',1,NULL,NULL),
      ('a:middle',2000,20,'a',1,NULL,NULL),
      ('a:latest',2100,5,'legacy-a',NULL,'isrc-a',NULL),
      ('b:latest',2500,25,'b',2,NULL,NULL),
      ('zero:latest',2600,0,'zero',NULL,NULL,NULL);
  `);
  return db;
}

test('like ranking keeps only the latest like or bite count for each resolved track', () => {
  const db = rankingDatabase();
  const rows = db.prepare(likeRankingSql()).all(500);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Song B');
  assert.equal(rows[0].latest_like_count, 25);
  assert.equal(rows[0].latest_observed_at, 2500);
  assert.equal(rows[1].title, 'Song A');
  assert.equal(rows[1].latest_like_count, 5);
  assert.equal(rows[1].latest_observed_at, 2100);
});

test('older high counters are not accumulated into the latest ranking', () => {
  const db = rankingDatabase();
  const rows = db.prepare(likeRankingSql()).all(500);
  assert.equal(rows[1].latest_like_count, 5);
  assert.equal(rows[0].ranking_track_count, 2);
  assert.equal(rows[0].ranking_max_like_count, 25);
  assert.equal(rows[0].ranking_latest_observed_at, 2500);
  assert.ok(!Object.hasOwn(rows[0], 'total_like_count'));
  assert.ok(!Object.hasOwn(rows[0], 'average_like_count'));
});

test('FACTS schema publishes an observed-time index for cached ranking reads', () => {
  const migration = readFileSync(
    new URL('../database/facts-migrations/012_counter_current_read_index.sql', import.meta.url),
    'utf8',
  );
  const descriptor = JSON.parse(readFileSync(
    new URL('../database/facts-db.json', import.meta.url),
    'utf8',
  ));
  assert.match(migration, /idx_sh_counter_current_observed_count/);
  assert.match(migration, /sh_track_counter_current\(observed_at DESC,count_value DESC\)/);
  assert.equal(descriptor.schema, 'database/facts-migrations/012_counter_current_read_index.sql');
});
