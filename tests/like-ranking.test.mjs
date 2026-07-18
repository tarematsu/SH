import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { GET } from '../site/functions/api/like-ranking.js';
import { applySqliteMigrations, createSqliteD1, seedSqlite } from './helpers/sqlite-d1.mjs';

async function rankingFixture() {
  const database = createSqliteD1();
  await applySqliteMigrations(database, [
    'database/facts-migrations/001_initial_schema.sql',
    'database/facts-migrations/002_normalize_minute_fact_enums.sql',
    'database/facts-migrations/003_compact_minute_facts.sql',
    'database/facts-migrations/004_buddies_queue_read_models.sql',
    'database/facts-migrations/005_minute_comment_tasks.sql',
    'database/facts-migrations/006_stream_goal_prediction_state.sql',
    'database/facts-migrations/007_remove_unused_runtime_tables.sql',
    'database/facts-migrations/008_buddies_downstream_archive.sql',
    'database/facts-migrations/009_mark_legacy_migration_complete.sql',
    'database/facts-migrations/010_sparse_context_and_counter_log.sql',
    'database/facts-migrations/011_repair_counter_current.sql',
    'database/facts-migrations/012_counter_current_read_index.sql',
  ]);
  await seedSqlite(database, `
    INSERT INTO sh_tracks(id,canonical_key,isrc,spotify_id,title,artist,first_seen_at,last_seen_at)
    VALUES
      (1,'isrc:JPAAA','JPAAA','spotify-a','A','櫻坂46',1,1),
      (2,'isrc:JPBBB','JPBBB','spotify-b','B','Sakurazaka46',1,1),
      (3,'isrc:USCCC','USCCC','spotify-c','C','櫻坂46',1,1),
      (4,'isrc:JPDDD','JPDDD','spotify-d','D','Other Artist',1,1);
    INSERT INTO sh_track_counter_changes(
      id,observed_at,occurrence_key,track_key,count_value,source
    ) VALUES
      (1,1000,'a','isrc:JPAAA',10,'collector'),
      (2,2000,'a','isrc:JPAAA',20,'collector'),
      (3,2500,'a','isrc:JPAAA',25,'collector'),
      (4,1500,'b','isrc:JPBBB',3,'collector'),
      (5,2100,'b','isrc:JPBBB',5,'collector'),
      (6,3000,'c','isrc:USCCC',100,'collector'),
      (7,3000,'d','isrc:JPDDD',100,'collector');
  `);
  return database;
}

test('like ranking keeps Sakurazaka artists and JP-prefixed ISRC tracks only', async () => {
  const database = await rankingFixture();
  const response = await GET({ env: { MINUTE_DB: database } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.rows.map((row) => row.track_id), [1, 2]);
});

test('like ranking keeps only the latest like or bite count for each eligible track', async () => {
  const database = await rankingFixture();
  const response = await GET({ env: { MINUTE_DB: database } });
  const { rows } = await response.json();
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
  assert.equal(descriptor.schema, 'database/facts-migrations/017_partial_queue_revision_coverage.sql');
});
