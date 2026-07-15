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
      ('a:1',1000,10,'a',1,NULL,NULL),
      ('a:2',2000,20,'a',1,NULL,NULL),
      ('a:3',2100,5,'legacy-a',NULL,'isrc-a',NULL),
      ('b:1',2500,25,'b',2,NULL,NULL),
      ('outside',500,100,'a',1,NULL,NULL),
      ('zero',2200,0,'zero',NULL,NULL,NULL);
  `);
  return db;
}

test('like ranking sums final like/bite counters once per occurrence and resolves track identity', () => {
  const db = rankingDatabase();
  const rows = db.prepare(likeRankingSql('total')).all(900, 3000, 500);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Song A');
  assert.equal(rows[0].total_like_count, 35);
  assert.equal(rows[0].peak_like_count, 20);
  assert.equal(rows[0].occurrence_count, 3);
  assert.equal(rows[0].period_like_count, 60);
  assert.equal(rows[0].period_occurrence_count, 4);
  assert.equal(rows[0].period_track_count, 2);
  assert.equal(rows[0].period_peak_like_count, 25);
});

test('like ranking can order by highest single-play counter without changing totals', () => {
  const db = rankingDatabase();
  const rows = db.prepare(likeRankingSql('peak')).all(900, 3000, 500);
  assert.equal(rows[0].title, 'Song B');
  assert.equal(rows[0].peak_like_count, 25);
  assert.equal(rows[1].title, 'Song A');
  assert.equal(rows[1].total_like_count, 35);
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
