import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../functions/lib/data-maintenance.js', import.meta.url),
  'utf8'
);

test('hourly legacy backfill remains limited to 1000 rows', () => {
  assert.match(source, /const LEGACY_BACKFILL_BATCH = 1_000;/);
  assert.match(source, /\.bind\(lastLegacyId, LEGACY_BACKFILL_BATCH\)\.first\(\)/);
});

test('retention cleanup no longer issues DELETE statements', () => {
  assert.doesNotMatch(source, /const CLEANUP_BATCH/);
  assert.doesNotMatch(source, /DELETE FROM sh_channel_snapshots/);
  assert.doesNotMatch(source, /DELETE FROM sh_raw_events/);
  assert.doesNotMatch(source, /DELETE FROM sh_realtime_metrics/);
  assert.doesNotMatch(source, /DELETE FROM sh_queue_snapshots/);
  assert.match(source, /const cleaned = false;/);
});
