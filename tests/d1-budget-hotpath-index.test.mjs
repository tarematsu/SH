import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const descriptor = JSON.parse(readFileSync(
  new URL('../database/facts-db.json', import.meta.url),
  'utf8',
));
const migration = readFileSync(
  new URL('../database/facts-migrations/025_d1_budget_hotpath_index.sql', import.meta.url),
  'utf8',
);
const runtime = JSON.parse(readFileSync(
  new URL('../worker/wrangler.runtime.jsonc', import.meta.url),
  'utf8',
));
const requestBudget = readFileSync(
  new URL('../scripts/cloudflare-worker-request-budget.mjs', import.meta.url),
  'utf8',
);

test('PR deployment applies the D1 budget hot-path indexes before the current schema tip', () => {
  assert.equal(descriptor.schema, 'database/facts-migrations/028_purge_completed_minute_fact_payloads.sql');
  assert.match(
    migration,
    /ON sh_minute_facts\(\s*source_code,\s*minute_at DESC,\s*id DESC,\s*channel_id,\s*observed_at,\s*is_broadcasting\s*\)/s,
  );
  assert.match(migration, /ON sh_minute_fact_jobs\(status, job_kind, minute_at, id\)/);
});

test('production keeps historical reconstruction enabled at D1-budgeted throughput', () => {
  assert.equal(runtime.vars.HISTORICAL_REBUILD_ENABLED, true);
  assert.equal(runtime.vars.REBUILD_HISTORICAL_BACKFILL_ENABLED, true);
  assert.equal(runtime.vars.REBUILD_HISTORICAL_BACKFILL_INTERVAL_MS, 3_600_000);
  assert.equal(runtime.vars.DERIVE_DISPATCH_LIMIT, 2);
  assert.equal(runtime.vars.DERIVE_REVISION_RECOVERY_LIMIT, 1);
  assert.equal(runtime.vars.REBUILD_SOURCE_ROWS, 20);
  assert.equal(runtime.vars.REBUILD_MAX_JOBS, 4);
  const historical = runtime.queues.consumers.find(
    ({ queue }) => queue === 'stationhead-minute-derive',
  );
  assert.equal(historical.max_batch_size, 1);
  assert.equal(historical.max_concurrency, 1);
  assert.match(requestBudget, /'stationhead-minute-derive'/);
  assert.match(requestBudget, /'stationhead-minute-rebuild'/);
  assert.doesNotMatch(requestBudget, /QUEUE_MESSAGES_PER_DAY[\s\S]*'stationhead-minute-derive':/);
});
