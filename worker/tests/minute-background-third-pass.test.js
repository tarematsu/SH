import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runMinuteMaintenanceScheduled } from '../src/minute-maintenance-optimized-entry.js';
import {
  historicalBackfillDue,
  processMinuteMaintenanceGate,
  processMinuteMaintenanceSync,
} from '../src/minute-rebuild-maintenance-entry.js';
import { processMinuteRebuildStage } from '../src/minute-rebuild-entry.js';

const MAINTENANCE_CRON = '5,7,9,15,17,19,25,27,29,35,37,39,45,47,49,55,57,59 * * * *';
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

function gateBody(task = 'rebuild', attempt = 0, scheduledAt = BASE) {
  return {
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    run_id: `minute-maintenance:${task}:${scheduledAt}`,
    stage: 'maintenance-gate',
    maintenance_task: task,
    scheduled_at: scheduledAt,
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

test('historical backfill is due once per configured day and can be disabled', () => {
  const env = { REBUILD_HISTORICAL_BACKFILL_INTERVAL_MS: 86_400_000 };
  assert.equal(historicalBackfillDue(env, BASE), true);
  assert.equal(historicalBackfillDue(env, BASE + 17 * 60_000), false);
  assert.equal(historicalBackfillDue({ ...env, REBUILD_HISTORICAL_BACKFILL_ENABLED: false }, BASE), false);
});

test('ready maintenance gate always dispatches gap repair but marks historical backfill only when due', async () => {
  const sent = [];
  const dependencies = {
    checkCollector: async () => ({ ready: true }),
    send: async (body, delaySeconds) => sent.push({ body, delaySeconds }),
  };
  const daily = await processMinuteMaintenanceGate({}, gateBody('rebuild', 0, BASE), dependencies);
  const incremental = await processMinuteMaintenanceGate(
    {},
    gateBody('rebuild', 0, BASE + 17 * 60_000),
    dependencies,
  );

  assert.equal(daily.dispatched_stage, 'gap-scan');
  assert.equal(daily.historical_backfill_due, true);
  assert.equal(sent[0].body.allow_backfill, true);
  assert.equal(incremental.dispatched_stage, 'gap-scan');
  assert.equal(incremental.historical_backfill_due, false);
  assert.equal(sent[1].body.allow_backfill, false);
});

test('non-daily gap repair completes without entering historical backfill', async () => {
  const enqueued = [];
  const recorded = [];
  const result = await processMinuteRebuildStage({
    BUDDIES_DB: {},
    MINUTE_DB: {},
  }, {
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    run_id: 'incremental-gap-only',
    stage: 'gap-scan',
    scheduled_at: BASE + 17 * 60_000,
    allow_backfill: false,
  }, {
    runGapScan: async () => ({ processed: 0, missing_minutes: 0 }),
    recordStage: async (_env, task, value) => recorded.push({ task, value }),
    enqueueStage: async (_env, _task, stage) => enqueued.push(stage),
  });

  assert.equal(result.pending, false);
  assert.equal(recorded.length, 1);
  assert.deepEqual(enqueued, []);
});

test('ready maintenance gate dispatches a separate sync Invocation', async () => {
  const sent = [];
  const sync = await processMinuteMaintenanceGate({}, gateBody('sync'), {
    checkCollector: async () => ({ ready: true }),
    send: async (body, delaySeconds) => sent.push({ body, delaySeconds }),
  });
  assert.equal(sync.pending, true);
  assert.equal(sync.dispatched_stage, 'maintenance-sync');
  assert.equal(sent[0].body.stage, 'maintenance-sync');
  assert.equal(sent[0].delaySeconds, 0);
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
