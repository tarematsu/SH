import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMigratedCursor,
  migratedRowsSql,
  migrationProgress,
  migrationStatsSql,
} from '../functions/api/history-migrated.js';

test('migrated history reads normalized legacy tables directly', () => {
  const sql = migratedRowsSql();
  assert.match(sql, /FROM sh_legacy_samples s/);
  assert.match(sql, /LEFT JOIN sh_legacy_tracks/);
  assert.match(sql, /LEFT JOIN sh_legacy_hosts/);
  assert.match(sql, /LEFT JOIN sh_legacy_broadcasts/);
  assert.doesNotMatch(sql, /sh_legacy_history_rows/);
  assert.doesNotMatch(sql, /sh_legacy_snapshots/);
});

test('migrated history adds bounded filters and cursor ordering', () => {
  const sql = migratedRowsSql({ host: true, track: true, cursor: true });
  assert.match(sql, /lower\(COALESCE\(h\.handle,''\)\) LIKE \?/);
  assert.match(sql, /lower\(COALESCE\(t\.title,''\)\) LIKE \?/);
  assert.match(sql, /s\.observed_at>\? OR \(s\.observed_at=\? AND s\.legacy_id>\?\)/);
  assert.match(sql, /ORDER BY s\.observed_at ASC,s\.legacy_id ASC LIMIT \?$/);
});

test('migration stats compare normalized and source rows', () => {
  const sql = migrationStatsSql();
  assert.match(sql, /COUNT\(\*\) FROM sh_legacy_samples/);
  assert.match(sql, /COUNT\(\*\) FROM sh_legacy_snapshots/);
  assert.match(sql, /legacy_backfill_id/);
});

test('migration progress never reports negative remaining rows', () => {
  assert.deepEqual(migrationProgress({ migrated_rows: 80, source_rows: 100 }), {
    migrated: 80,
    source: 100,
    remaining: 20,
    percent: 80,
  });
  assert.deepEqual(migrationProgress({ migrated_rows: 120, source_rows: 100 }), {
    migrated: 120,
    source: 100,
    remaining: 0,
    percent: 100,
  });
});

test('migrated cursor rejects malformed values', () => {
  assert.deepEqual(decodeMigratedCursor(Buffer.from('123:45').toString('base64')), { timestamp: 123, id: 45 });
  assert.equal(decodeMigratedCursor('not-base64***'), null);
  assert.equal(decodeMigratedCursor(Buffer.from('-1:45').toString('base64')), null);
  assert.equal(decodeMigratedCursor(Buffer.from('123').toString('base64')), null);
});
