import { rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const stateDirectory = path.resolve('.wrangler-pages-test-state');
const executable = process.platform === 'win32'
  ? path.resolve('node_modules/.bin/wrangler.cmd')
  : path.resolve('node_modules/.bin/wrangler');
const databaseDirectory = path.resolve('..', 'database');
const schemaFiles = [
  'schema.sql',
  'history-schema.sql',
  'host-monitoring.sql',
  'track-like-observations.sql',
  'ranking-all-schema.sql',
  'migrations/004_collector_coordination.sql',
];

function run(args) {
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    env: { ...process.env, CI: 'true' },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function executeFile(filename) {
  console.log(`Applying current D1 schema: ${filename}`);
  run([
    'd1', 'execute', 'stationhead-monitor',
    '--local', '--persist-to', stateDirectory,
    '--file', path.join(databaseDirectory, filename),
  ]);
}

rmSync(stateDirectory, { recursive: true, force: true });

try {
  for (const filename of schemaFiles) executeFile(filename);

  run([
    'd1', 'execute', 'stationhead-monitor',
    '--local', '--persist-to', stateDirectory,
    '--command', 'PRAGMA integrity_check;',
  ]);

  const requiredTables = [
    'sh_channel_snapshots',
    'sh_queue_snapshots',
    'sh_queue_items',
    'sh_track_metadata',
    'sh_ingest_claims',
    'sh_host_broadcast_sessions',
    'sh_host_station_snapshots',
    'sh_host_raw_events',
    'sh_channel_rankings',
    'sh_legacy_snapshots',
    'sh_track_like_observations',
    'sh_weekly_summary',
  ];
  for (const table of requiredTables) {
    run([
      'd1', 'execute', 'stationhead-monitor',
      '--local', '--persist-to', stateDirectory,
      '--command', `SELECT COUNT(*) AS row_count FROM ${table};`,
    ]);
  }
} finally {
  rmSync(stateDirectory, { recursive: true, force: true });
}
