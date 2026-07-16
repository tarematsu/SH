import { rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const stateDirectory = path.resolve('.wrangler-pages-test-state');
const wranglerScript = path.resolve('node_modules/wrangler/bin/wrangler.js');
const repositoryRoot = path.resolve('..');
const configPath = path.resolve('wrangler.jsonc');

const databases = [
  {
    binding: 'DB',
    files: [
      'database/buddies-migrations/001_initial_schema.sql',
      'database/buddies-migrations/002_minute_fact_outbox.sql',
      'database/buddies-migrations/003_compact_sent_minute_fact_outbox.sql',
      'database/buddies-migrations/004_change_only_like_history.sql',
      'database/buddies-migrations/005_canonical_track_like_keys.sql',
    ],
    requiredTables: [
      'sh_channel_snapshots',
      'sh_queue_snapshots',
      'sh_queue_items',
      'sh_track_metadata',
      'sh_ingest_claims',
      'sh_data_maintenance_state',
    ],
  },
  {
    binding: 'OTHER_DB',
    files: [
      'database/other-migrations/001_initial_schema.sql',
      'database/other-migrations/002_solo_activity_tables.sql',
      'database/other-migrations/003_buddy_playback_state.sql',
      'database/other-migrations/004_track_metadata.sql',
      'database/other-migrations/007_archive_gap_completion.sql',
      'database/other-migrations/008_retire_unowned_state.sql',
      'database/other-migrations/009_drop_duplicate_track_metadata.sql',
      'database/other-migrations/010_drop_legacy_snapshots.sql',
      'database/other-migrations/011_buddy_playback_canonical.sql',
    ],
    requiredTables: [
      'sh_host_broadcast_sessions',
      'sh_official_broadcast_summary',
      'sh_daily_summary',
      'sh_weekly_summary',
      'sh_monthly_summary',
      'sh_playback_channel_current',
      'sh_buddy_playback_clock',
      'sh_buddy_track_metadata',
    ],
  },
];

function run(args) {
  const result = spawnSync(process.execPath, [wranglerScript, ...args, '--config', configPath], {
    cwd: process.cwd(),
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${output}\nwrangler ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function executeFile(binding, filename) {
  console.log(`Applying current ${binding} schema: ${filename}`);
  run([
    'd1', 'execute', binding,
    '--local', '--persist-to', stateDirectory,
    '--file', path.join(repositoryRoot, filename),
  ]);
}

rmSync(stateDirectory, { recursive: true, force: true });

try {
  for (const database of databases) {
    for (const filename of database.files) executeFile(database.binding, filename);
    for (const table of database.requiredTables) {
      run([
        'd1', 'execute', database.binding,
        '--local', '--persist-to', stateDirectory,
        '--command', `SELECT COUNT(*) AS row_count FROM ${table};`,
      ]);
    }
  }
  console.log('Current D1 schema smoke test passed.');
} finally {
  rmSync(stateDirectory, { recursive: true, force: true });
}
