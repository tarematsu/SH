import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { TRACK_RANKING_SQL } from '../site/functions/lib/track-history-restored-handler.js';

function rankingDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sh_tracks(
      id INTEGER PRIMARY KEY,
      stationhead_track_id INTEGER,
      spotify_id TEXT,
      isrc TEXT,
      title TEXT,
      artist TEXT,
      display_title TEXT,
      thumbnail_url TEXT,
      spotify_url TEXT,
      updated_at INTEGER
    );
    CREATE TABLE sh_track_counter_current(
      track_id INTEGER,
      counter_id INTEGER,
      count_value INTEGER,
      observed_at INTEGER
    );
    CREATE TABLE sh_track_counter_dictionary(
      id INTEGER PRIMARY KEY,
      counter_type TEXT,
      counter_key TEXT
    );
    INSERT INTO sh_tracks VALUES
      (1,10,'sp1','JPTEST1','A','Artist A','A — Artist A',NULL,NULL,100),
      (2,20,'sp2','JPTEST2','B','Artist B','B — Artist B',NULL,NULL,100),
      (3,30,NULL,NULL,'C','Artist C','C — Artist C',NULL,NULL,100);
    INSERT INTO sh_track_counter_dictionary VALUES
      (1,'like','isrc:JPTEST1'),
      (2,'like','spotify:sp1'),
      (3,'like','isrc:JPTEST2'),
      (4,'like','stationhead:30');
    INSERT INTO sh_track_counter_current VALUES
      (1,1,20,2000),
      (1,2,25,2500),
      (2,3,5,2100),
      (3,4,99,2600);
  `);
  return db;
}

test('track history ranking keeps only the latest count for each eligible track', () => {
  const db = rankingDatabase();
  const rows = db.prepare(TRACK_RANKING_SQL).all(500);
  assert.equal(rows[0].latest_like_count, 25);
  assert.equal(rows[0].latest_observed_at, 2500);
  assert.equal(rows[1].latest_like_count, 5);
  assert.equal(rows[1].latest_observed_at, 2100);
  assert.equal(rows[0].ranking_track_count, 2);
  assert.equal(rows[0].ranking_max_like_count, 25);
  assert.equal(rows[0].ranking_latest_observed_at, 2500);
  assert.ok(!Object.hasOwn(rows[0], 'total_like_count'));
  assert.ok(!Object.hasOwn(rows[0], 'average_like_count'));
});

test('FACTS schema publishes observed-time indexes, retired API cleanup, and payload purge', () => {
  const indexMigration = readFileSync(
    new URL('../database/facts-migrations/012_counter_current_read_index.sql', import.meta.url),
    'utf8',
  );
  const cleanupMigration = readFileSync(
    new URL('../database/facts-migrations/027_purge_retired_api_read_models.sql', import.meta.url),
    'utf8',
  );
  const payloadMigration = readFileSync(
    new URL('../database/facts-migrations/028_purge_completed_minute_fact_payloads.sql', import.meta.url),
    'utf8',
  );
  const descriptor = JSON.parse(readFileSync(
    new URL('../database/facts-db.json', import.meta.url),
    'utf8',
  ));
  assert.match(indexMigration, /idx_sh_counter_current_observed_count/);
  assert.match(indexMigration, /sh_track_counter_current\(observed_at DESC,count_value DESC\)/);
  assert.match(cleanupMigration, /dashboard-daily-changes/);
  assert.match(cleanupMigration, /playback:buddies/);
  assert.match(payloadMigration, /UPDATE sh_minute_fact_jobs/);
  assert.match(payloadMigration, /SET payload_json='\{\}'/);
  assert.equal(descriptor.schema, 'database/facts-migrations/028_purge_completed_minute_fact_payloads.sql');
});
