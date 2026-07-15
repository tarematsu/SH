import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workerRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(workerRoot, '..');
const stateDirectory = path.resolve(workerRoot, '.wrangler-minute-facts-test-state');
const executable = process.execPath;
const wranglerScript = path.resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const schemaPath = path.resolve(repositoryRoot, 'database/facts-migrations/001_initial_schema.sql');
const compactMigrationPath = path.resolve(repositoryRoot, 'database/facts-migrations/003_compact_minute_facts.sql');
const predictionMigrationPath = path.resolve(repositoryRoot, 'database/facts-migrations/006_stream_goal_prediction_state.sql');
const cleanupMigrationPath = path.resolve(repositoryRoot, 'database/facts-migrations/007_remove_unused_runtime_tables.sql');
const downstreamArchiveMigrationPath = path.resolve(repositoryRoot, 'database/facts-migrations/008_buddies_downstream_archive.sql');
const factsBinding = 'MINUTE_DB';
const minuteConfigPath = path.resolve(workerRoot, 'wrangler.minute.jsonc');

function run(args) {
  const result = spawnSync(executable, [wranglerScript, ...args, '--config', minuteConfigPath], {
    cwd: workerRoot,
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout;
}

test('minute facts D1 schema applies and exposes required tables', { timeout: 60_000 }, () => {
  rmSync(stateDirectory, { recursive: true, force: true });
  try {
    run([
      'd1', 'execute', factsBinding,
      '--local', '--persist-to', stateDirectory,
      '--file', schemaPath,
    ]);
    run([
      'd1', 'execute', factsBinding,
      '--local', '--persist-to', stateDirectory,
      '--file', compactMigrationPath,
    ]);
    run([
      'd1', 'execute', factsBinding,
      '--local', '--persist-to', stateDirectory,
      '--file', predictionMigrationPath,
    ]);
    run([
      'd1', 'execute', factsBinding,
      '--local', '--persist-to', stateDirectory,
      '--file', cleanupMigrationPath,
    ]);
    run([
      'd1', 'execute', factsBinding,
      '--local', '--persist-to', stateDirectory,
      '--file', downstreamArchiveMigrationPath,
    ]);
    const requiredTables = [
      'sh_minute_facts',
      'sh_minute_fact_context',
      'sh_minute_fact_collectors',
      'sh_broadcast_sessions',
      'sh_queue_revisions',
      'sh_queue_revision_items',
      'sh_queue_state_events',
      'sh_playback_current',
      'sh_tracks',
      'sh_track_aliases',
      'sh_hosts',
      'sh_host_aliases',
      'sh_track_bite_observations',
      'sh_migration_state',
      'sh_stream_goal_prediction_state',
      'sh_buddies_sync_state',
      'sh_queue_item_observations',
      'sh_track_like_observations',
      'sh_track_metadata',
    ];
    const tables = run([
      'd1', 'execute', factsBinding,
      '--local', '--persist-to', stateDirectory,
      '--command', "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
    ]);
    for (const table of requiredTables) assert.match(tables, new RegExp(`\\b${table}\\b`));
    assert.doesNotMatch(tables, /sh_system_settings|sh_minute_facts_v2|sh_minute_facts_compact|sh_minute_fact_context_compact/);
    const compactColumns = run([
      'd1', 'execute', factsBinding,
      '--local', '--persist-to', stateDirectory,
      '--command', "SELECT name FROM pragma_table_info('sh_minute_facts') ORDER BY cid;",
    ]);
    assert.match(compactColumns, /collector_code/);
    assert.match(compactColumns, /track_confidence_code/);
    assert.match(compactColumns, /quality_score_code/);
    assert.doesNotMatch(compactColumns, /collector_id/);
    assert.doesNotMatch(compactColumns, /validated_stream_count/);
    assert.doesNotMatch(compactColumns, /stream_count_rejected/);

    const compactIndexes = run([
      'd1', 'execute', factsBinding,
      '--local', '--persist-to', stateDirectory,
      '--command', "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_sh_minute_facts%';",
    ]);
    assert.match(compactIndexes, /idx_sh_minute_facts_source_record/);
    assert.match(compactIndexes, /idx_sh_minute_facts_time/);
    assert.doesNotMatch(compactIndexes, /host_time|track_time|session_time/);
    const views = run([
      'd1', 'execute', factsBinding,
      '--local', '--persist-to', stateDirectory,
      '--command', "SELECT name FROM sqlite_master WHERE type='view' ORDER BY name;",
    ]);
    for (const view of ['sh_channel_snapshots', 'sh_queue_current', 'sh_queue_items', 'sh_queue_snapshots', 'sh_track_like_current']) {
      assert.match(views, new RegExp(`\\b${view}\\b`));
    }
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
