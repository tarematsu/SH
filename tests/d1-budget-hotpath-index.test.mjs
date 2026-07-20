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

test('PR deployment applies the D1 budget hot-path indexes', () => {
  assert.equal(descriptor.schema, 'database/facts-migrations/025_d1_budget_hotpath_index.sql');
  assert.match(migration, /ON sh_minute_facts\(source_code, minute_at DESC, id DESC\)/);
  assert.match(migration, /ON sh_minute_fact_jobs\(status, job_kind, minute_at, id\)/);
});

test('production disables historical rebuild traffic under the D1 budget', () => {
  assert.equal(runtime.vars.HISTORICAL_REBUILD_ENABLED, false);
  assert.equal(runtime.vars.REBUILD_HISTORICAL_BACKFILL_ENABLED, false);
  const historical = runtime.queues.consumers.find(
    ({ queue }) => queue === 'stationhead-minute-derive',
  );
  assert.equal(historical.max_batch_size, 1);
  assert.equal(historical.max_concurrency, 1);
});
