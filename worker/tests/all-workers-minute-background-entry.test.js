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
  assert.match(entry, /function logMinuteEnrichmentResult/);
  assert.doesNotMatch(entry, /for\s*\(|Symbol\.iterator|fetch\s*\(/);
});

test('minute rebuild keeps cached core stages behind the maintenance-aware one-message wrapper', () => {
  const config = source('../wrangler.minute-rebuild.jsonc');
  const wrapper = source('../src/minute-rebuild-maintenance-entry.js');
  const core = source('../src/minute-rebuild-entry.js');
  assert.match(config, /"main"\s*:\s*"src\/minute-rebuild-maintenance-entry\.js"/);
  assert.match(config, /"max_batch_size"\s*:\s*1\b/);
  assert.match(core, /runtimeStateModulePromise \|\|=/);
  assert.match(core, /gapScanModulePromise \|\|=/);
  assert.match(core, /backfillModulePromise \|\|=/);
  assert.match(wrapper, /const message = messages\[0\]/);
  assert.match(wrapper, /processMinuteMaintenanceGate/);
  assert.doesNotMatch(core, /\['gap-scan'.*\.includes\(stage\)/s);
  assert.doesNotMatch(wrapper, /fetch\s*\(/);
});

test('minute maintenance preserves its public entry while delegating scheduled work to the delayed-gate wrapper', () => {
  const config = source('../wrangler.minute.jsonc');
  const entry = source('../src/minute-maintenance-entry.js');
  const wrapper = source('../src/minute-maintenance-optimized-entry.js');
  assert.match(config, /"main"\s*:\s*"src\/minute-maintenance-entry\.js"/);
  assert.match(entry, /import optimizedMaintenanceWorker/);
  assert.match(entry, /export default optimizedMaintenanceWorker/);
  assert.match(wrapper, /const JSON_QUEUE_SEND_OPTIONS = Object\.freeze/);
  assert.match(wrapper, /stage: 'maintenance-gate'/);
  assert.match(wrapper, /scheduled: runMinuteMaintenanceScheduled/);
  assert.doesNotMatch(wrapper, /setTimeout|waitForCollectorCompletion|fetch\s*:/);
});
