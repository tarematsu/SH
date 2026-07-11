import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../functions/lib/data-maintenance.js', import.meta.url),
  'utf8'
);

test('legacy backfill is fully disabled', () => {
  assert.doesNotMatch(source, /LEGACY_BACKFILL_BATCH/);
  assert.doesNotMatch(source, /sh_legacy_snapshots/);
  assert.doesNotMatch(source, /sh_legacy_samples/);
  assert.match(source, /export function legacyMigrationEnabled\(\) \{\s+return false;/);
  assert.match(source, /legacy-migration-disabled/);
});

test('retention cleanup no longer issues DELETE statements', () => {
  assert.doesNotMatch(source, /const CLEANUP_BATCH/);
  assert.doesNotMatch(source, /DELETE FROM sh_channel_snapshots/);
  assert.doesNotMatch(source, /DELETE FROM sh_raw_events/);
  assert.doesNotMatch(source, /DELETE FROM sh_realtime_metrics/);
  assert.doesNotMatch(source, /DELETE FROM sh_queue_snapshots/);
  assert.match(source, /const cleaned = false;/);
});
