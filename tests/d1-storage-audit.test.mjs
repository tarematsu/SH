import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/audit-d1-storage.yml', import.meta.url),
  'utf8',
);
const script = readFileSync(
  new URL('../scripts/cloudflare-d1-storage-audit.mjs', import.meta.url),
  'utf8',
);

test('D1 storage audit is manual and keeps the page walk opt-in', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|schedule:/);
  assert.match(workflow, /D1_STORAGE_DEEP_AUDIT/);
  assert.match(workflow, /npm ci --no-audit --no-fund/);
  assert.match(script, /if \(deepAudit\)/);
  assert.match(script, /FROM dbstat/);
  assert.doesNotMatch(script, /COUNT\(\*\) FROM sh_minute_facts|COUNT\(\*\) FROM sh_minute_fact_jobs/);
  assert.match(script, /queryRowsRead/);
  assert.match(script, /wrangler\(\['d1', 'list', '--json'\]\)/);
});
