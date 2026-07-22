import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const scriptUrl = new URL('.github/scripts/audit-cloudflare-free-tier.py', root);
const script = readFileSync(scriptUrl, 'utf8');
const runtime = JSON.parse(readFileSync(new URL('worker/wrangler.runtime.jsonc', root), 'utf8'));
const responseStore = readFileSync(new URL('worker/src/pages-response-store.js', root), 'utf8');
const responseEntry = readFileSync(new URL('worker/src/pages-read-model-entry.js', root), 'utf8');
const coreEntry = readFileSync(new URL('worker/src/runtime-orchestrator-entry.js', root), 'utf8');
const queuePlanR2 = readFileSync(new URL('worker/src/queue-plan-r2.js', root), 'utf8');
const pagesMiddleware = readFileSync(new URL('site/functions/_middleware.js', root), 'utf8');

test('Cloudflare resource budgets are fixed at 80 percent of included usage', () => {
  assert.match(script, /"queueOperations": 8_000/);
  assert.match(script, /"doRequests": 80_000/);
  assert.match(script, /"doActiveGbSeconds": 10_400\.0/);
  assert.match(script, /"doRowsRead": 4_000_000/);
  assert.match(script, /"doRowsWritten": 80_000/);
  assert.match(script, /"doStoredBytes": 4 \* GB/);
  assert.match(script, /"r2ClassAOperations": 800_000/);
  assert.match(script, /"r2ClassBOperations": 8_000_000/);
  assert.match(script, /"r2StoredBytes": 8 \* GB/);
  assert.match(script, /"kvReads": 80_000/);
  assert.match(script, /"kvWrites": 800/);
  assert.match(script, /"kvDeletes": 800/);
  assert.match(script, /"kvLists": 800/);
  assert.match(script, /"kvStoredBytes": 800_000_000/);
  assert.match(script, /"pipelineTransformBytes": 800_000_000/);
  assert.match(script, /"pipelineSinkBytes": 800_000_000/);
  assert.match(script, /queueMessageOperationsAdaptiveGroups/);
  assert.match(script, /durableObjectsPeriodicGroups/);
  assert.match(script, /r2OperationsAdaptiveGroups/);
  assert.match(script, /kvOperationsAdaptiveGroups/);
  assert.match(script, /kvStorageAdaptiveGroups/);
  assert.match(script, /pipelinesOperatorAdaptiveGroups/);
  assert.match(script, /pipelinesSinkAdaptiveGroups/);
  const result = spawnSync('python3', [fileURLToPath(scriptUrl), '--self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('the coordinator and remaining scheduled Queues fit safely below daily budgets', () => {
  const maximumCoordinatorRequests = 24 * 60;
  // The DO only reads and overwrites one ticket. Slow scheduled work runs in
  // the caller, so allow a conservative full second of DO active time per RPC.
  const maximumCoordinatorDuration = maximumCoordinatorRequests * 1 * 0.128;
  const maximumCoordinatorRowsRead = maximumCoordinatorRequests;
  const maximumCoordinatorRowsWritten = maximumCoordinatorRequests;
  // Recovery: 288/day; maintenance gate: 432/day; prediction: 48/day;
  // hourly tasks: 48/day; Pages heavy variants: 17/day. Routine Pages work is
  // executed inside the coordinator. A sustained inline collection failure
  // adds at most two messages every five minutes. Each message is 3 operations.
  const maximumQueueOperations = (288 + 432 + 48 + 48 + 17 + 288 * 2) * 3;
  assert.ok(maximumCoordinatorRequests < 80_000);
  assert.ok(maximumCoordinatorDuration < 10_400);
  assert.ok(maximumCoordinatorRowsRead < 4_000_000);
  assert.ok(maximumCoordinatorRowsWritten < 80_000);
  assert.ok(maximumQueueOperations < 8_000);
  assert.equal(runtime.vars.PIPELINE_ANALYTICS_INTERVAL_MINUTES, 5);
  assert.equal(runtime.vars.RAW_COLLECTION_FALLBACK_INTERVAL_MINUTES, 5);
  assert.equal(runtime.durable_objects.bindings[0].class_name, 'RuntimeCoordinator');
  assert.match(coreEntry, /await stub\.claim/);
  assert.match(coreEntry, /runtime:last-scheduled-ticket/);
  assert.match(coreEntry, /runPagesReadModelCron/);
  assert.doesNotMatch(coreEntry, /pages-read-model-scheduled-dispatch/);
});

test('surplus KV and R2 capacity replaces materialized-response D1 writes and reads', () => {
  assert.match(responseStore, /if \(kvSaved\)/);
  assert.match(responseStore, /if \(r2Saved\) return r2Saved/);
  assert.doesNotMatch(responseStore, /saveD1Response|sh_pages_response_manifest|sh_pages_response_chunks/);
  assert.doesNotMatch(pagesMiddleware, /sh_pages_response_manifest|sh_pages_response_chunks/);
  assert.match(responseEntry, /await loadKv[\s\S]*\|\| await loadR2/);
  assert.match(queuePlanR2, /operational\/queue-plan\/v1/);
  assert.match(queuePlanR2, /await r2\.delete/);

  const maximumDailyVariantWrites = 17;
  const maximumDailyDashboardWrites = 24 * 60 / 5;
  const maximumDailyKvWrites = maximumDailyDashboardWrites + maximumDailyVariantWrites;
  const maximumMonthlyR2Mirrors = maximumDailyKvWrites * 31;
  const maximumMonthlyQueuePlanReads = 24 * 60 * 31;
  // Pathological structure churn: get + two invalidations + one put per minute.
  const maximumMonthlyQueuePlanClassA = 3 * 24 * 60 * 31;
  const maximumMonthlyPipelineBytes = Math.ceil(31 * 24 * 60 / 5) * 4_096;
  assert.ok(maximumDailyKvWrites < 800);
  assert.ok(maximumMonthlyR2Mirrors + maximumMonthlyQueuePlanClassA < 800_000);
  assert.ok(maximumMonthlyQueuePlanReads < 8_000_000);
  assert.ok(maximumMonthlyPipelineBytes < 800_000_000);
});
