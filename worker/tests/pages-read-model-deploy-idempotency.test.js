import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../scripts/deploy-pages-read-model.mjs', import.meta.url),
  'utf8',
);

test('read-model redeploy rollback preserves a pre-existing consolidated consumer', () => {
  assert.match(source, /const consolidatedBefore = hasConsumer\(consolidatedScript\)/);
  assert.match(source, /if \(!consolidatedBefore && hasConsumer\(consolidatedScript\)\)/);
  assert.doesNotMatch(source, /capture: true, allowFailure: true/);
});

test('read-model retirement API calls have a bounded timeout', () => {
  assert.match(source, /AbortSignal\.timeout\(20_000\)/);
});
