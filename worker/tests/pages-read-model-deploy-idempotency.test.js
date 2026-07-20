import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const compatibilitySource = readFileSync(
  new URL('../scripts/deploy-pages-read-model.mjs', import.meta.url),
  'utf8',
);
const source = readFileSync(
  new URL('../scripts/deploy-minute-enrichment.mjs', import.meta.url),
  'utf8',
);

test('read-model redeploy rollback preserves a pre-existing consolidated consumer', () => {
  assert.match(source, /consolidatedBefore: hasConsumer\(spec\.queue, consolidatedScript\)/);
  assert.match(source, /if \(!migration\.consolidatedBefore && hasConsumer\(migration\.queue, consolidatedScript\)\)/);
  assert.doesNotMatch(source, /capture: true, allowFailure: true/);
  assert.match(compatibilitySource, /deploy-minute-enrichment\.mjs/);
});

test('read-model retirement API calls have a bounded timeout', () => {
  assert.match(source, /AbortSignal\.timeout\(20_000\)/);
});

test('Pages KV deployment is validated against the strict 10 ms CPU contract', () => {
  const budget = readFileSync(
    new URL('../../.github/scripts/enforce-worker-cpu-budget.py', import.meta.url),
    'utf8',
  );
  assert.match(budget, /BUDGET_MS = 10\.0/);
  assert.match(budget, /"comparison": "less_than"/);
});
