import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function config(path) {
  return JSON.parse(source(path));
}

test('core Worker routes enrichment through a queue-only one-message wrapper', () => {
  const runtime = config('../wrangler.runtime.jsonc');
  const entry = source('../src/minute-enrichment-optimized-entry.js');
  const router = source('../src/runtime-orchestrator-entry.js');
  const enrichment = runtime.queues.consumers.find(
    ({ queue }) => queue === 'stationhead-minute-enrichment',
  );
  assert.equal(runtime.main, 'src/runtime-orchestrator-deployed-entry.js');
  assert.equal(enrichment.max_batch_size, 1);
  assert.equal(enrichment.max_concurrency, 1);
  assert.match(router, /minute-enrichment-optimized-entry\.js/);
  assert.match(entry, /const message = messages\[0\]/);
  assert.match(entry, /function logMinuteEnrichmentResult/);
  assert.doesNotMatch(entry, /Symbol\.iterator|fetch\s*\(/);
});

test('runtime Worker owns single-message rebuild delivery while preserving cached core stages', () => {
  const runtime = config('../wrangler.runtime.jsonc');
  const wrapper = source('../src/minute-rebuild-batched-entry.js');
  const core = source('../src/minute-rebuild-entry.js');
  const rebuild = runtime.queues.consumers.find(({ queue }) => queue === 'stationhead-minute-rebuild');
  assert.equal(rebuild.max_batch_size, 1);
  assert.equal(rebuild.max_concurrency, 1);
  assert.match(core, /runtimeStateModulePromise \|\|=/);
  assert.match(core, /gapScanModulePromise \|\|=/);
  assert.match(core, /backfillModulePromise \|\|=/);
  assert.match(wrapper, /for \(const message of messages\)/);
  assert.match(wrapper, /processMinuteMaintenanceGate/);
  assert.match(wrapper, /processMinuteRebuildStage/);
  assert.doesNotMatch(wrapper, /fetch\s*\(/);
});

test('runtime scheduled orchestration delegates maintenance to the delayed gate', () => {
  const scheduled = source('../src/runtime-scheduled.js');
  const wrapper = source('../src/minute-maintenance-optimized-entry.js');
  assert.match(scheduled, /dispatchMinuteMaintenanceGate/);
  assert.match(wrapper, /const JSON_QUEUE_SEND_OPTIONS = Object\.freeze/);
  assert.match(wrapper, /stage: 'maintenance-gate'/);
  assert.match(wrapper, /scheduled: runMinuteMaintenanceScheduled/);
  assert.doesNotMatch(wrapper, /setTimeout|waitForCollectorCompletion|fetch\s*:/);
});
