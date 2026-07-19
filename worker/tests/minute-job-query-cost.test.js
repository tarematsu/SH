import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { minuteFactInboxStats } from '../src/minute-facts-inbox.js';

test('minute inbox health uses targeted status probes instead of a full conditional aggregate', async () => {
  let sql = '';
  const MINUTE_DB = {
    prepare(value) {
      sql = value;
      return {
        async first() {
          return {
            pending_count: 2,
            processing_count: 1,
            dead_count: 0,
            rebuild_pending_count: 1,
            live_pending_count: 1,
            oldest_pending_minute: 60_000,
          };
        },
      };
    },
  };
  const result = await minuteFactInboxStats({ MINUTE_DB });
  assert.equal(result.pending_count, 2);
  assert.match(sql, /SELECT COUNT\(\*\) FROM sh_minute_fact_jobs WHERE status='pending'/);
  assert.match(sql, /SELECT MIN\(minute_at\) FROM sh_minute_fact_jobs WHERE status='pending'/);
  assert.doesNotMatch(sql, /SUM\(CASE WHEN/);
});

test('facts migration installs partial dispatch indexes without indexing completed jobs', () => {
  const migration = readFileSync(
    new URL('../../database/facts-migrations/021_minute_job_dispatch_indexes.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /WHERE status='pending'/);
  assert.match(migration, /WHERE status='processing'/);
  assert.doesNotMatch(migration, /status='done'/);
});
