import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../functions/lib/data-maintenance.js', import.meta.url),
  'utf8'
);

test('hourly legacy backfill is limited to 1000 rows', () => {
  assert.match(source, /const LEGACY_BACKFILL_BATCH = 1_000;/);
  assert.match(source, /\.bind\(lastLegacyId, LEGACY_BACKFILL_BATCH\)\.first\(\)/);
});

test('retention cleanup keeps its independent 5000-row batch', () => {
  assert.match(source, /const CLEANUP_BATCH = 5_000;/);
  assert.doesNotMatch(source, /const CLEANUP_BATCH = 1_000;/);
});
