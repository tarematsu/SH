import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('minute enrichment deploys the queue-only one-message wrapper', () => {
  const config = source('../wrangler.minute-enrichment.jsonc');
  const entry = source('../src/minute-enrichment-optimized-entry.js');
  assert.match(config, /"main"\s*:\s*"src\/minute-enrichment-optimized-entry\.js"/);
  assert.match(config, /"max_batch_size"\s*:\s*1\b/);
  assert.match(entry, /const message = messages\[0\]/);
  assert.doesNotMatch(entry, /for\s*\(|Symbol\.iterator|fetch\s*\(/);
});

test('minute rebuild caches stage modules and uses one-message dispatch', () => {
  const config = source('../wrangler.minute-rebuild.jsonc');
  const entry = source('../src/minute-rebuild-entry.js');
  assert.match(config, /"max_batch_size"\s*:\s*1\b/);
  assert.match(entry, /runtimeStateModulePromise \|\|=/);
  assert.match(entry, /gapScanModulePromise \|\|=/);
  assert.match(entry, /backfillModulePromise \|\|=/);
  assert.match(entry, /const message = messages\[0\]/);
  assert.doesNotMatch(entry, /\['gap-scan'.*\.includes\(stage\)/s);
  assert.doesNotMatch(entry, /fetch\s*\(/);
});

test('minute maintenance exposes only scheduled work and reuses Queue options', () => {
  const entry = source('../src/minute-maintenance-entry.js');
  assert.match(entry, /const JSON_QUEUE_SEND_OPTIONS = Object\.freeze/);
  assert.match(entry, /function isDeriveDispatchCron/);
  assert.match(entry, /export default \{\s*scheduled\(/s);
  assert.doesNotMatch(entry, /fetch\s*:/);
});
