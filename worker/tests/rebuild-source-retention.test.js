import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const retention = readFileSync(new URL('../src/snapshot-retention.js', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../../database/buddies-migrations/009_rebuild_source_retention_30d.sql', import.meta.url),
  'utf8',
);
const manifest = JSON.parse(readFileSync(
  new URL('../../database/buddies-db.json', import.meta.url),
  'utf8',
));
const runtime = JSON.parse(readFileSync(new URL('../wrangler.runtime.jsonc', import.meta.url), 'utf8'));

test('all durable reconstruction sources share a thirty-day retention floor', () => {
  assert.match(retention, /REBUILD_SOURCE_RETENTION_MS = 30 \* 24 \* 60 \* 60_000/);
  assert.match(retention, /MIN_RETENTION_MS = REBUILD_SOURCE_RETENTION_MS/);
  assert.match(retention, /name: 'sh_channel_snapshots'/);
  assert.match(retention, /name: 'sh_queue_snapshots'/);
  assert.match(retention, /name: 'sh_comment_minute_counts'/);
  assert.match(retention, /timeColumn: 'bucket_start'/);
  assert.equal(runtime.vars.SNAPSHOT_RETENTION_MS, 30 * 24 * 60 * 60_000);
});

test('current buddies migration removes the obsolete two-day comment cleanup trigger', () => {
  assert.equal(manifest.schema, 'database/buddies-migrations/010_gap_scan_channel_seek.sql');
  assert.match(migration, /DROP TRIGGER IF EXISTS trg_sh_claim_retention/);
  assert.doesNotMatch(migration, /172800000/);
  assert.doesNotMatch(migration, /DELETE FROM sh_comment_minute_counts/);
});
