import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workerRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(workerRoot, '..');
const stateDirectory = path.resolve(workerRoot, '.wrangler-minute-facts-test-state');
const executable = process.platform === 'win32'
  ? path.resolve(workerRoot, 'node_modules/.bin/wrangler.cmd')
  : path.resolve(workerRoot, 'node_modules/.bin/wrangler');
const schemaPath = path.resolve(repositoryRoot, 'database/facts-migrations/001_initial_schema.sql');

function run(args) {
  const result = spawnSync(executable, args, {
    cwd: workerRoot,
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout;
}

test('minute facts D1 schema applies and exposes required tables', { timeout: 60_000 }, () => {
  rmSync(stateDirectory, { recursive: true, force: true });
  try {
    run([
      'd1', 'execute', 'sh-monitor',
      '--local', '--persist-to', stateDirectory,
      '--file', schemaPath,
    ]);
    const requiredTables = [
      'sh_minute_facts',
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
    ];
    for (const table of requiredTables) {
      run([
        'd1', 'execute', 'sh-monitor',
        '--local', '--persist-to', stateDirectory,
        '--command', `SELECT COUNT(*) AS row_count FROM ${table};`,
      ]);
    }
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
