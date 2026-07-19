import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runMinuteMaintenanceScheduled } from '../src/minute-maintenance-optimized-entry.js';
import {
  processMinuteMaintenanceGate,
  processMinuteMaintenanceSync,
} from '../src/minute-rebuild-maintenance-entry.js';

const MAINTENANCE_CRON = '5,7,9,15,17,19,25,27,29,35,37,39,45,47,49,55,57,59 * * * *';
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

function gateBody(task = 'rebuild', attempt = 0) {
  return {
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    run_id: `minute-maintenance:${task}:${BASE}`,
    stage: 'maintenance-gate',
    maintenance_task: task,
    scheduled_at: BASE,
    cron: MAINTENANCE_CRON,
    attempt,
  };
}

test('maintenance Cron publishes a delayed gate instead of polling inside the scheduled Invocation', async () => {
  const sent = [];
  const scheduledAt = BASE + 9 * 60_000;
  const result = await runMinuteMaintenanceScheduled({
    cron: MAINTENANCE_CRON,
    scheduledTime: scheduledAt,
  }, {
    CRON_STAGGER_MINUTE_MS: 12_000,
    MINUTE_REBUILD_QUEUE: {
      async send(body, options) { sent.push({ body, options }); },
    },
  }, {});

  assert.equal(result.task, 'sync');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.stage, 'maintenance-gate');
  assert.equal(sent[0].body.maintenance_task, 'sync');
  assert.equal(sent[0].options.delaySeconds, 12);
});

test('maintenance gate performs one collector check and requeues without an in-Invocation polling loop', async () => {
  const sent = [];
  const result = await processMinuteMaintenanceGate({}, gateBody('rebuild'), {
    checkCollector: async () => ({ ready: false, reason: 'collector-not-ready' }),
    send: async (body, delaySeconds) => sent.push({ body, delaySeconds }),
  });

  assert.equal(result.requeued, true);
  assert.equal(result.attempt, 1);
  assert.equal(sent[0].body.attempt, 1);
  assert.equal(sent[0].delaySeconds, 4);
});

test('ready maintenance gate dispatches rebuild or a separate sync Invocation', async () => {
  const sent = [];
  const rebuild = await processMinuteMaintenanceGate({}, gateBody('rebuild'), {
    checkCollector: async () => ({ ready: true }),
    send: async (body, delaySeconds) => sent.push({ body, delaySeconds }),
  });
  assert.equal(rebuild.dispatched_stage, 'gap-scan');
  assert.equal(sent[0].body.stage, 'gap-scan');

  const sync = await processMinuteMaintenanceGate({}, gateBody('sync'), {
    checkCollector: async () => ({ ready: true }),
    send: async (body, delaySeconds) => sent.push({ body, delaySeconds }),
  });
  assert.equal(sync.pending, true);
  assert.equal(sync.dispatched_stage, 'maintenance-sync');
  assert.equal(sent[1].body.stage, 'maintenance-sync');
  assert.equal(sent[1].delaySeconds, 0);
});

test('maintenance sync executes only after the collector gate Invocation', async () => {
  let scheduled = null;
  const result = await processMinuteMaintenanceSync({}, {
    ...gateBody('sync'),
    stage: 'maintenance-sync',
  }, {
    runScheduled: async (controller, _env, dependencies) => {
      scheduled = { controller, dependencies };
      return { event: 'sync-complete' };
    },
  });
  assert.equal(result.pending, false);
  assert.equal(result.stage, 'maintenance-sync');
  assert.equal(scheduled.controller.scheduledTime, BASE);
  assert.equal(scheduled.dependencies.collectorReady, true);
});

test('enrichment production wrapper logs fixed fields instead of spreading the complete result', () => {
  const source = readFileSync(new URL('../src/minute-enrichment-optimized-entry.js', import.meta.url), 'utf8');
  assert.match(source, /function logMinuteEnrichmentResult/);
  assert.match(source, /const RETRY_30_SECONDS = Object\.freeze/);
  assert.doesNotMatch(source, /minute_enrichment_completed', \.\.\.result/);
});
