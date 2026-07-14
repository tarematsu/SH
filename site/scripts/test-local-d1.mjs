import { rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const stateDirectory = path.resolve('.wrangler-pages-test-state');
const wranglerScript = path.resolve('node_modules/wrangler/bin/wrangler.js');
const databaseDirectory = path.resolve('..', 'database');
const schemaFiles = [
  'schema.sql',
  'history-schema.sql',
  'host-monitoring.sql',
  'track-like-observations.sql',
  'migrations/004_collector_coordination.sql',
  'migrations/131_drop_local_collector_backup.sql',
];

function run(args) {
  const result = spawnSync(process.execPath, [wranglerScript, ...args], {
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

function executeFile(filename) {
  console.log(`Applying current D1 schema: ${filename}`);
  run([
    'd1', 'execute', 'stationhead-legacy',
    '--local', '--persist-to', stateDirectory,
    '--file', path.join(databaseDirectory, filename),
  ]);
}

rmSync(stateDirectory, { recursive: true, force: true });

try {
  for (const filename of schemaFiles) executeFile(filename);

  const requiredTables = [
    'sh_channel_snapshots',
    'sh_queue_snapshots',
    'sh_queue_items',
    'sh_playback_channel_current',
    'sh_track_metadata',
    'sh_ingest_claims',
    'sh_host_broadcast_sessions',
    'sh_host_station_snapshots',
    'sh_host_raw_events',
    'sh_legacy_snapshots',
    'sh_track_like_observations',
    'sh_weekly_summary',
  ];
  for (const table of requiredTables) {
    run([
      'd1', 'execute', 'stationhead-legacy',
      '--local', '--persist-to', stateDirectory,
      '--command', `SELECT COUNT(*) AS row_count FROM ${table};`,
    ]);
  }
  console.log('Current D1 schema smoke test passed.');
} finally {
  rmSync(stateDirectory, { recursive: true, force: true });
}
