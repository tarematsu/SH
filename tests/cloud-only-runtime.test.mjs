import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const repository = new URL('../', import.meta.url);

test('repository contains no local collector or scraper runtime', () => {
  for (const relativePath of [
    'collector',
    'scraper',
    'worker/src/collector-http.js',
    'worker/src/collector-failover-lease.js',
    'worker/src/request-hardening.js',
    'worker/src/resilient-entry.js',
  ]) {
    assert.equal(existsSync(new URL(relativePath, repository)), false, relativePath);
  }
});

test('cleanup migration removes legacy local coordination storage', () => {
  const migration = readFileSync(
    new URL('database/migrations/131_drop_local_collector_backup.sql', repository),
    'utf8',
  );
  assert.match(migration, /DROP TABLE IF EXISTS sh_collector_leases/);
  assert.match(migration, /DROP TABLE IF EXISTS sh_local_outbox_receipts/);
});
