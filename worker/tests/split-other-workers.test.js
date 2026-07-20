import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ROLLUP_MAINTENANCE_CRON,
  SNAPSHOT_RETENTION_CRON,
} from '../src/monitor-maintenance-entry.js';
import {
  MONITOR_MAINTENANCE_MESSAGE,
  OTHER_MONITOR_CRON,
  runRuntimeScheduled,
} from '../src/runtime-scheduled.js';
import { runRuntimeQueue } from '../src/runtime-queue.js';

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('runtime Worker config owns orchestration boundaries', () => {
  const worker = config('wrangler.runtime.jsonc');
  assert.equal(worker.name, 'sh-runtime-orchestrator');
  assert.equal(worker.main, 'src/runtime-orchestrator-entry.js');
  assert.deepEqual(worker.triggers.crons, ['* * * * *']);
  assert.deepEqual(worker.d1_databases.map(({ binding }) => binding), [
    'BUDDIES_DB',
    'MINUTE_DB',
    'OTHER_DB',
  ]);
  assert.deepEqual(worker.queues.consumers.map(({ queue }) => queue), [
    'stationhead-buddy-playback',
    'stationhead-host-monitor',
    'stationhead-minute-derive',
    'stationhead-minute-live-derive',
    'stationhead-buddies-facts',
    'stationhead-minute-rebuild',
  ]);
  assert.equal(worker.queues.producers.some(({ binding }) => binding === 'MINUTE_ENRICHMENT_QUEUE'), true);
  assert.equal(worker.vars.CRON_STAGGER_OTHER_MS, 25_000);
  assert.equal(worker.vars.COLLECTOR_PRIORITY_WAIT_MS, 15_000);
  assert.equal(worker.vars.SNAPSHOT_RETENTION_ENABLED, true);
});

test('runtime scheduled handler dispatches maintenance without adding a Cron', async () => {
  const sent = [];
  const scheduledTime = BASE + 30 * 60_000;
  const result = await runRuntimeScheduled(
    { cron: OTHER_MONITOR_CRON, scheduledTime },
    {
      HOST_MONITOR_QUEUE: {
        async send(body, options) { sent.push({ body, options }); },
      },
    },
    {},
    {
      collectRawChannel: async () => ({ collected: true }),
      otherOptions: {
        dependencies: { buddy: async () => 'buddy' },
        recordSuccess: async () => {},
        healthApp: { invalidateHealthCache() {} },
      },
    },
  );

  assert.deepEqual(sent, [{
    body: {
      message_type: MONITOR_MAINTENANCE_MESSAGE,
      message_version: 1,
      cron: ROLLUP_MAINTENANCE_CRON,
      scheduled_at: scheduledTime,
    },
    options: { contentType: 'json' },
  }]);
  assert.equal(result.at(-1).task, 'maintenance');
});

test('runtime Queue handler executes maintenance and preserves ack ownership', async () => {
  const events = [];
  const message = {
    body: {
      message_type: MONITOR_MAINTENANCE_MESSAGE,
      cron: ROLLUP_MAINTENANCE_CRON,
      scheduled_at: BASE + 30 * 60_000,
    },
    ack() { events.push('ack'); },
    retry() { events.push('retry'); },
  };

  await runRuntimeQueue(
    { messages: [message] },
    { BUDDIES_DB: {}, OTHER_DB: {} },
    {},
    {
      maintenanceDependencies: {
        applyStagger: async () => events.push('stagger'),
        waitForCollector: async () => ({ ready: true }),
        runRollup: async () => { events.push('rollup'); return 'rollup'; },
      },
    },
  );
  assert.deepEqual(events, ['stagger', 'rollup', 'ack']);
});

test('runtime Queue router processes every message in a mixed batch', async () => {
  const events = [];
  await runRuntimeQueue(
    {
      messages: [
        {
          body: {
            message_type: MONITOR_MAINTENANCE_MESSAGE,
            cron: ROLLUP_MAINTENANCE_CRON,
            scheduled_at: BASE + 30 * 60_000,
          },
          ack() { events.push('maintenance-ack'); },
          retry() { events.push('maintenance-retry'); },
        },
        {
          body: { message_type: 'unsupported-monitor-message' },
          ack() { events.push('other-ack'); },
          retry() { events.push('other-retry'); },
        },
      ],
    },
    { BUDDIES_DB: {}, OTHER_DB: {} },
    {},
    {
      maintenanceDependencies: {
        applyStagger: async () => {},
        waitForCollector: async () => ({ ready: true }),
        runRollup: async () => 'rollup',
      },
    },
  );
  assert.deepEqual(events, ['maintenance-ack', 'other-retry']);
});

test('runtime Queue router delegates minute pipeline batches unchanged', async () => {
  const events = [];
  await runRuntimeQueue(
    {
      queue: 'stationhead-minute-live-derive',
      messages: [{
        body: { message_type: 'minute-fact-derive' },
        ack() { events.push('ack'); },
        retry() { events.push('retry'); },
      }],
    },
    { BUDDIES_DB: {}, MINUTE_DB: {} },
    {},
    {
      minutePipelineDependencies: {
        derive: { processMessage: async () => ({ processed: 0 }) },
      },
    },
  );
  assert.deepEqual(events, ['ack']);
});

test('maintenance failures remain Queue retries', async () => {
  const events = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    await runRuntimeQueue(
      {
        messages: [{
          body: {
            message_type: MONITOR_MAINTENANCE_MESSAGE,
            cron: SNAPSHOT_RETENTION_CRON,
            scheduled_at: BASE + 50 * 60_000,
          },
          ack() { events.push('ack'); },
          retry() { events.push('retry'); },
        }],
      },
      { BUDDIES_DB: {}, OTHER_DB: {} },
      {},
      {
        maintenanceDependencies: {
          applyStagger: async () => {},
          waitForCollector: async () => ({ ready: true }),
          pruneSnapshots: async () => ({
            skipped: true,
            reason: 'retention-error',
            error: 'delete failed',
          }),
        },
      },
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(events, ['retry']);
});

test('runtime scheduled handler rejects unknown schedules', async () => {
  assert.deepEqual(
    await runRuntimeScheduled({ cron: '1 2 3 4 5' }, {}, {}),
    { skipped: true, reason: 'unsupported-runtime-cron', cron: '1 2 3 4 5' },
  );
});
