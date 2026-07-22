import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { TRACK_RANKING_SQL } from '../site/functions/lib/track-ranking.js';

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
      occurrence_key TEXT PRIMARY KEY,
      track_key TEXT NOT NULL,
      track_id INTEGER,
      isrc TEXT,
      spotify_id TEXT,
      count_value INTEGER NOT NULL,
      observed_at INTEGER NOT NULL
    );
    INSERT INTO sh_tracks VALUES
      (1,10,'sp1','JPTEST1','A','櫻坂46','A — 櫻坂46',NULL,NULL,100),
      (2,20,'sp2','JPTEST2','B','Artist B','B — Artist B',NULL,NULL,100),
      (3,30,'sp3','USTEST3','C','Artist C','C — Artist C',NULL,NULL,100);
    INSERT INTO sh_track_counter_current VALUES
      ('occ-1','isrc:JPTEST1',1,'JPTEST1','sp1',20,2000),
      ('occ-2','isrc:JPTEST1',1,'JPTEST1','sp1',25,2500),
      ('occ-3','isrc:JPTEST2',2,'JPTEST2','sp2',5,2100),
      ('occ-4','isrc:USTEST3',3,'USTEST3','sp3',99,2600);
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
  const publicationIndexMigration = readFileSync(
    new URL('../database/facts-migrations/029_track_history_publication_cursor_index.sql', import.meta.url),
    'utf8',
  );
  const purgeScript = readFileSync(
    new URL('../worker/scripts/purge-completed-minute-fact-payloads.mjs', import.meta.url),
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
  assert.match(payloadMigration, /trg_sh_minute_fact_payload_after_job_done/);
  assert.match(payloadMigration, /SET payload_json='\{\}'/);
  assert.match(publicationIndexMigration, /idx_sh_pages_track_history_publication_cursor/);
  assert.match(purgeScript, /UPDATE sh_minute_fact_jobs SET payload_json='\{\}'/);
  assert.match(purgeScript, /remainingEligibleJobId != null/);
  assert.doesNotMatch(purgeScript, /SUM\(LENGTH\(payload_json\)\)/);
  assert.equal(descriptor.schema, 'database/facts-migrations/029_track_history_publication_cursor_index.sql');
});
