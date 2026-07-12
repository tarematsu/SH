import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertRuntimeMigrationCoverage,
  changedMigrationNames,
  uncoveredRuntimeMigrations,
} from '../scripts/d1-runtime-coverage.mjs';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(siteRoot, '..');

test('known runtime-bootstrapped migration is accepted', () => {
  assert.deepEqual(
    uncoveredRuntimeMigrations(['127_add_secondary_playback_current.sql']),
    [],
  );
  assert.equal(
    assertRuntimeMigrationCoverage(repositoryRoot, ['127_add_secondary_playback_current.sql']),
    true,
  );
});

test('runtime coverage tracks newly added bootstrap migrations without flagging old edits', () => {
  const names = changedMigrationNames(repositoryRoot);
  assert.ok(names.includes('008_buddy_auth_control.sql'));
  assert.ok(names.includes('128_add_collector_status.sql'));
  assert.ok(names.includes('129_add_queue_reachability_index.sql'));
  assert.ok(!names.includes('003_email_stream_snapshots.sql'));
  assert.equal(assertRuntimeMigrationCoverage(repositoryRoot, names), true);
});

test('new migration without runtime coverage is rejected', () => {
  assert.deepEqual(
    uncoveredRuntimeMigrations(['128_uncovered_change.sql']),
    ['128_uncovered_change.sql'],
  );
  assert.throws(
    () => assertRuntimeMigrationCoverage(repositoryRoot, ['128_uncovered_change.sql']),
    /without runtime coverage/,
  );
});

test('tokenless production build guard succeeds when the current commit adds no uncovered migration', () => {
  const env = { ...process.env, CF_PAGES: '1', CF_PAGES_BRANCH: 'main' };
  for (const key of [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_BUILDS_API_TOKEN',
    'D1_MIGRATION_FORCE',
  ]) delete env[key];
  const result = spawnSync(process.execPath, [
    path.join(siteRoot, 'scripts', 'check-tokenless-d1-coverage.mjs'),
  ], {
    cwd: siteRoot,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Tokenless D1 coverage check completed successfully/);
});
