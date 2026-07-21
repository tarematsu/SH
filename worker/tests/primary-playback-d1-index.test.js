import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../database/facts-migrations/025_d1_budget_hotpath_index.sql', import.meta.url),
  'utf8',
);
const verification = readFileSync(
  new URL('../scripts/verify-facts-live.mjs', import.meta.url),
  'utf8',
);

test('newest live fact probes retain a covering descending index', () => {
  assert.match(
    migration,
    /idx_sh_minute_facts_live_minute\s*\nON sh_minute_facts\(\s*source_code,\s*minute_at DESC,\s*id DESC,\s*channel_id,\s*observed_at,\s*is_broadcasting\s*\)/s,
  );
  assert.match(
    verification,
    /FROM sh_minute_facts INDEXED BY idx_sh_minute_facts_live_minute\s*\n\s*WHERE source_code=1/,
  );
});
