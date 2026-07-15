import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../functions/lib/data-maintenance.js', import.meta.url),
  'utf8'
);

test('legacy Pages maintenance is retired', () => {
  assert.doesNotMatch(source, /LEGACY_BACKFILL_BATCH/);
  assert.doesNotMatch(source, /sh_legacy_snapshots/);
  assert.doesNotMatch(source, /sh_legacy_samples/);
  assert.match(source, /export function legacyMigrationEnabled\(\) \{\s+return false;/);
  assert.match(source, /legacy-maintenance-retired/);
});

test('retired maintenance has no D1 write path', () => {
  assert.doesNotMatch(source, /INSERT INTO/);
  assert.doesNotMatch(source, /UPDATE /);
  assert.doesNotMatch(source, /DELETE FROM/);
});
