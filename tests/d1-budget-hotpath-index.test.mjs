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
const observabilityHotpathMigration = readFileSync(
  new URL('../database/facts-migrations/031_observability_hotpaths.sql', import.meta.url),
  'utf8',
);
const materializedCleanupRankingMigration = readFileSync(
  new URL('../database/facts-migrations/032_materialized_cleanup_ranking.sql', import.meta.url),
  'utf8',
);
const payloadTransitionMigration = readFileSync(
  new URL('../database/facts-migrations/033_fix_payload_clearable_transitions.sql', import.meta.url),
  'utf8',
);
const dashboardRollupMigration = readFileSync(
  new URL('../database/facts-migrations/034_dashboard_rollup_inbox_stats.sql', import.meta.url),
  'utf8',
);
const dashboardRecoveryMigration = readFileSync(
  new URL('../database/facts-migrations/035_recover_dashboard_rollup_schema.sql', import.meta.url),
  'utf8',
);
const playbackPositionMigration = readFileSync(
  new URL('../database/facts-migrations/036_minute_fact_playback_position.sql', import.meta.url),
  'utf8',
);
const remainingHotpathsMigration = readFileSync(
  new URL('../database/facts-migrations/037_remaining_d1_hotpaths.sql', import.meta.url),
  'utf8',
);
const deploySafeHotpathsMigration = readFileSync(
  new URL('../database/facts-migrations/038_deploy_safe_remaining_hotpaths.sql', import.meta.url),
  'utf8',
);
const writeAmplificationMigration = readFileSync(
  new URL('../database/facts-migrations/039_reduce_fact_write_amplification.sql', import.meta.url),
  'utf8',
);
const sparseLiveMetricMigration = readFileSync(
  new URL('../database/facts-migrations/040_sparse_live_metric_values.sql', import.meta.url),
  'utf8',
);
const restoreCompleteMetricMigration = readFileSync(
  new URL('../database/facts-migrations/041_restore_complete_live_metrics.sql', import.meta.url),
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
  'database/facts-migrations/031_observability_hotpaths.sql',
  'database/facts-migrations/032_materialized_cleanup_ranking.sql',
  'database/facts-migrations/033_fix_payload_clearable_transitions.sql',
  'database/facts-migrations/034_dashboard_rollup_inbox_stats.sql',
  'database/facts-migrations/035_recover_dashboard_rollup_schema.sql',
  'database/facts-migrations/036_minute_fact_playback_position.sql',
  'database/facts-migrations/037_remaining_d1_hotpaths.sql',
  'database/facts-migrations/038_deploy_safe_remaining_hotpaths.sql',
  'database/facts-migrations/039_reduce_fact_write_amplification.sql',
  'database/facts-migrations/040_sparse_live_metric_values.sql',
  'database/facts-migrations/041_restore_complete_live_metrics.sql',
];

test('MINUTE_DB deployment selects changed migrations through the current schema tip', () => {
  assert.equal(descriptor.binding, 'MINUTE_DB');
  assert.equal(descriptor.schema, expectedMigrations.at(-1));
  assert.deepEqual(descriptor.migrations, expectedMigrations);
  assert.match(prSchema, /descriptor\.migrations/);
  assert.match(prSchema, /ordered-migration-set/);
  assert.match(prSchema, /changed-migration-set/);
  assert.match(prSchema, /schema-tip-fallback/);
  assert.match(prSchema, /FACTS_DEPLOY_CHANGED_ONLY/);
  assert.match(prSchema, /git[\s\S]*diff[\s\S]*database\/facts-migrations/);
  assert.match(prSchema, /026_remove_apple_music_compatibility\.sql/);
  assert.match(prSchema, /appleMusicCompatibilityPresent/);
  assert.match(prSchema, /036_minute_fact_playback_position\.sql/);
  assert.match(prSchema, /playbackPositionColumnPresent/);
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
  assert.match(observabilityHotpathMigration, /idx_sh_queue_revisions_sparse_recovery/);
  assert.match(observabilityHotpathMigration, /sh_track_history_queue_starts/);
  assert.match(materializedCleanupRankingMigration, /idx_sh_minute_fact_jobs_payload_clearable/);
  assert.match(materializedCleanupRankingMigration, /sh_track_ranking_current/);
  assert.match(materializedCleanupRankingMigration, /trg_sh_track_ranking_current_after_counter_update/);
  assert.match(payloadTransitionMigration, /AFTER UPDATE OF source_job_id,status/);
  assert.match(payloadTransitionMigration, /AFTER DELETE ON sh_queue_revisions/);
  assert.match(payloadTransitionMigration, /id=OLD\.source_job_id OR id=NEW\.source_job_id/);
  assert.match(dashboardRollupMigration, /CREATE TABLE IF NOT EXISTS sh_dashboard_history_5m/);
  assert.match(dashboardRollupMigration, /CREATE TABLE IF NOT EXISTS sh_minute_fact_inbox_stats/);
  assert.match(dashboardRollupMigration, /trg_sh_minute_fact_inbox_stats_update/);
  assert.match(dashboardRecoveryMigration, /CREATE TABLE IF NOT EXISTS sh_dashboard_history_5m/);
  assert.match(dashboardRecoveryMigration, /CREATE TABLE IF NOT EXISTS sh_minute_fact_inbox_stats/);
  assert.match(dashboardRecoveryMigration, /CREATE TRIGGER IF NOT EXISTS trg_sh_minute_fact_inbox_stats_update/);
  assert.doesNotMatch(dashboardRecoveryMigration, /FROM sh_minute_facts/);
  assert.doesNotMatch(dashboardRecoveryMigration, /ANALYZE|PRAGMA optimize/);
  assert.match(playbackPositionMigration, /ALTER TABLE sh_minute_facts ADD COLUMN queue_position_patch/);
  assert.match(remainingHotpathsMigration, /INSERT OR IGNORE INTO sh_track_aliases/);
  assert.match(remainingHotpathsMigration, /idx_sh_minute_fact_jobs_pending_ready/);
  assert.match(remainingHotpathsMigration, /COALESCE\(f\.queue_position_patch,v\.queue_position\)/);
  assert.match(deploySafeHotpathsMigration, /idx_sh_minute_fact_jobs_pending_ready/);
  assert.match(deploySafeHotpathsMigration, /COALESCE\(f\.queue_position_patch,v\.queue_position\)/);
  assert.doesNotMatch(deploySafeHotpathsMigration, /INSERT|FROM sh_tracks|ANALYZE|PRAGMA optimize/);
  assert.match(writeAmplificationMigration, /DROP INDEX IF EXISTS idx_sh_minute_facts_source_minute_desc/);
  assert.match(writeAmplificationMigration, /DROP INDEX IF EXISTS idx_sh_minute_facts_total_listens_baseline/);
  assert.doesNotMatch(writeAmplificationMigration, /CREATE INDEX|INSERT|UPDATE|DELETE|ANALYZE|PRAGMA optimize/);
  assert.match(sparseLiveMetricMigration, /previous\.comment_count/);
  assert.match(sparseLiveMetricMigration, /previous\.reported_total_listens/);
  assert.match(restoreCompleteMetricMigration, /f\.reported_total_listens AS total_listens/);
  assert.match(restoreCompleteMetricMigration, /f\.comment_count AS comment_velocity/);
  assert.doesNotMatch(restoreCompleteMetricMigration, /SELECT previous|PRAGMA optimize/);
});

test('production pauses historical reconstruction while Queue usage exceeds budget', () => {
  assert.equal(runtime.vars.HISTORICAL_REBUILD_ENABLED, false);
  assert.equal(runtime.vars.REBUILD_HISTORICAL_BACKFILL_ENABLED, false);
  assert.equal(runtime.vars.REBUILD_HISTORICAL_BACKFILL_INTERVAL_MS, 3_600_000);
  assert.equal(runtime.vars.DERIVE_DISPATCH_LIMIT, 2);
  assert.equal(runtime.vars.DERIVE_REVISION_RECOVERY_LIMIT, 1);
  assert.equal(runtime.vars.DERIVE_REVISION_RECOVERY_SCAN_INTERVAL_MS, 3_600_000);
  assert.equal(runtime.vars.LIVE_DERIVE_DIRECT_QUEUE_ENABLED, true);
  assert.equal(runtime.vars.REVISION_PROGRESS_R2_ENABLED, true);
  assert.equal(runtime.vars.REBUILD_SOURCE_ROWS, 20);
  assert.equal(runtime.vars.REBUILD_MAX_JOBS, 4);
  const historical = runtime.queues.consumers.find(
    ({ queue }) => queue === 'stationhead-minute-derive',
  );
  assert.equal(historical.max_batch_size, 1);
  assert.equal(historical.max_concurrency, 1);
});
