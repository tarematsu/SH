import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../scripts/deploy-minute-enrichment.mjs', import.meta.url),
  'utf8',
);

test('metadata redeploy rollback preserves a pre-existing consolidated consumer', () => {
  assert.match(source, /consolidatedBefore: hasConsumer\(spec\.queue, consolidatedScript\)/);
  assert.match(source, /if \(!migration\.consolidatedBefore && hasConsumer\(migration\.queue, consolidatedScript\)\)/);
  assert.doesNotMatch(source, /capture: true, allowFailure: true/);
});

test('metadata retirement API calls have a bounded timeout', () => {
  assert.match(source, /AbortSignal\.timeout\(20_000\)/);
});

test('metadata consolidation is validated against the strict 10 ms CPU contract', () => {
  const budget = readFileSync(
    new URL('../../.github/scripts/enforce-worker-cpu-budget.py', import.meta.url),
    'utf8',
  );
  assert.match(budget, /BUDGET_MS = 10\.0/);
  assert.match(budget, /"comparison": "less_than"/);
});

test('metadata consolidation composes with the merged paginated Pages KV deploy', () => {
  const pagesKv = readFileSync(
    new URL('../scripts/pages-response-kv-namespace.mjs', import.meta.url),
    'utf8',
  );
  assert.match(pagesKv, /NextContinuationToken|page=\$\{page\}/);
  assert.match(pagesKv, /NAMESPACE_PAGE_SIZE = 1000/);
});
