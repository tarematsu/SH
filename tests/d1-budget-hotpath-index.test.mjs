import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const descriptor = JSON.parse(readFileSync(
  new URL('../database/facts-db.json', import.meta.url),
  'utf8',
));
const migration = readFileSync(
  new URL('../database/facts-migrations/025_d1_budget_hotpath_index.sql', import.meta.url),
  'utf8',
);
const publicationCursorMigration = readFileSync(
  new URL('../database/facts-migrations/029_track_history_publication_cursor_index.sql', import.meta.url),
  'utf8',
);
const compactTrackHistoryMigration = readFileSync(
  new URL('../database/facts-migrations/030_compact_track_history_source.sql', import.meta.url),
  'utf8',
);
const prSchema = readFileSync(
  new URL('../worker/scripts/apply-facts-pr-schema.mjs', import.meta.url),
  'utf8',
);
const runtime = JSON.parse(readFileSync(
  new URL('../worker/wrangler.runtime.jsonc', import.meta.url),
  'utf8',
));

const expectedMigrations = [
  'database/facts-migrations/025_d1_budget_hotpath_index.sql',
  'database/facts-migrations/026_remove_apple_music_compatibility.sql',
  'database/facts-migrations/027_purge_retired_api_read_models.sql',
  'database/facts-migrations/028_purge_completed_minute_fact_payloads.sql',
  'database/facts-migrations/029_track_history_publication_cursor_index.sql',
  'database/facts-migrations/030_compact_track_history_source.sql',
];

test('PR deployment applies the ordered FACTS migration set through the current schema tip', () => {
  assert.equal(descriptor.schema, expectedMigrations.at(-1));
  assert.deepEqual(descriptor.migrations, expectedMigrations);
  assert.match(prSchema, /descriptor\.migrations/);
  assert.match(prSchema, /ordered-migration-set/);
  assert.match(prSchema, /026_remove_apple_music_compatibility\.sql/);
  assert.match(prSchema, /appleMusicCompatibilityPresent/);
  assert.match(
    migration,
    /ON sh_minute_facts\(\s*source_code,\s*minute_at DESC,\s*id DESC,\s*channel_id,\s*observed_at,\s*is_broadcasting\s*\)/s,
  );
  assert.match(migration, /ON sh_minute_fact_jobs\(status, job_kind, minute_at, id\)/);
  assert.match(
    publicationCursorMigration,
    /ON sh_pages_track_history_read_model\(\s*play_date,\s*COALESCE\(first_played_at,-1\),\s*row_key\s*\)/s,
  );
  assert.match(compactTrackHistoryMigration, /idx_sh_queue_revisions_track_history_latest/);
  assert.match(compactTrackHistoryMigration, /sh_minute_fact_context_v2/);
  assert.doesNotMatch(compactTrackHistoryMigration, /ROW_NUMBER\(\) OVER/);
});

test('production keeps historical reconstruction serialized for measured daily budgets', () => {
  assert.equal(runtime.vars.HISTORICAL_REBUILD_ENABLED, true);
  assert.equal(runtime.vars.REBUILD_HISTORICAL_BACKFILL_ENABLED, true);
  assert.equal(runtime.vars.REBUILD_HISTORICAL_BACKFILL_INTERVAL_MS, 3_600_000);
  assert.equal(runtime.vars.DERIVE_DISPATCH_LIMIT, 2);
  assert.equal(runtime.vars.DERIVE_REVISION_RECOVERY_LIMIT, 1);
  assert.equal(runtime.vars.REBUILD_SOURCE_ROWS, 20);
  assert.equal(runtime.vars.REBUILD_MAX_JOBS, 4);
  const historical = runtime.queues.consumers.find(
    ({ queue }) => queue === 'stationhead-minute-derive',
  );
  assert.equal(historical.max_batch_size, 1);
  assert.equal(historical.max_concurrency, 1);
});
