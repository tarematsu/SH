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
  RAW_COLLECTION_TASK_MESSAGE,
  RUNTIME_MINUTE_GATE_MESSAGE,
  RUNTIME_MINUTE_RECOVERY_MESSAGE,
  RUNTIME_OTHER_MONITOR_MESSAGE,
  runRuntimeScheduled,
  runtimeScheduledMessagesFor,
} from '../src/runtime-scheduled.js';
import { runRuntimeQueue } from '../src/runtime-queue.js';

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

function queueMessage(body, events, prefix = '') {
  return {
    body,
    ack() { events.push(`${prefix}ack`); },
    retry() { events.push(`${prefix}retry`); },
  };
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

test('runtime Cron uses one Queue batch instead of executing work inline', async () => {
  const batches = [];
  const scheduledTime = BASE + 30 * 60_000;
  const result = await runRuntimeScheduled(
    { cron: OTHER_MONITOR_CRON, scheduledTime },
    { HOST_MONITOR_QUEUE: { async sendBatch(messages) { batches.push(messages); } } },
  );

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(({ body }) => body), [
    {
      message_type: RAW_COLLECTION_TASK_MESSAGE,
      message_version: 1,
      scheduled_at: scheduledTime,
    },
    {
      message_type: RUNTIME_OTHER_MONITOR_MESSAGE,
      message_version: 1,
      scheduled_at: scheduledTime,
    },
    {
      message_type: MONITOR_MAINTENANCE_MESSAGE,
      message_version: 1,
      cron: ROLLUP_MAINTENANCE_CRON,
      scheduled_at: scheduledTime,
    },
  ]);
  assert.deepEqual(batches[0].map(({ contentType }) => contentType), ['json', 'json', 'json']);
  assert.deepEqual(result.map(({ task }) => task), ['raw-collection', 'other-monitor', 'maintenance']);
});

test('runtime Cron creates bounded messages for recovery and maintenance gates', () => {
  assert.deepEqual(runtimeScheduledMessagesFor(BASE + 36 * 60_000).map(({ message_type }) => message_type), [
    RAW_COLLECTION_TASK_MESSAGE,
    RUNTIME_MINUTE_RECOVERY_MESSAGE,
  ]);
  assert.deepEqual(runtimeScheduledMessagesFor(BASE + 37 * 60_000).map(({ message_type, task }) => [message_type, task]), [
    [RAW_COLLECTION_TASK_MESSAGE, undefined],
    [RUNTIME_MINUTE_GATE_MESSAGE, 'rebuild'],
  ]);
});

test('runtime Queue handler executes raw collection in an isolated invocation', async () => {
  const events = [];
  const message = queueMessage({
    message_type: RAW_COLLECTION_TASK_MESSAGE,
    message_version: 1,
    scheduled_at: BASE,
  }, events);
  await runRuntimeQueue({ messages: [message] }, {
    RAW_COLLECTION_QUEUE: { send() {} },
  }, {}, {
    async collectRawChannel(activeEnv) {
      assert.equal(typeof activeEnv.RAW_COLLECTION_QUEUE?.send, 'function');
      events.push('collect');
    },
  });
  assert.deepEqual(events, ['collect', 'ack']);
});

test('runtime Queue handler isolates recovery, gate, and monitor dispatches', async () => {
  const events = [];
  const messages = [
    queueMessage({
      message_type: RUNTIME_MINUTE_RECOVERY_MESSAGE,
      message_version: 1,
      scheduled_at: BASE + 36 * 60_000,
    }, events, 'recovery-'),
    queueMessage({
      message_type: RUNTIME_MINUTE_GATE_MESSAGE,
      message_version: 1,
      task: 'rebuild',
      scheduled_at: BASE + 37 * 60_000,
    }, events, 'gate-'),
    queueMessage({
      message_type: RUNTIME_OTHER_MONITOR_MESSAGE,
      message_version: 1,
      scheduled_at: BASE + 40 * 60_000,
    }, events, 'monitor-'),
  ];

  await runRuntimeQueue({ messages }, {}, {}, {
    async dispatchPendingMinuteFacts() { events.push('recovery-run'); },
    async dispatchMinuteMaintenanceGate(_controller, _env, task) {
      events.push(`gate-run-${task}`);
    },
    async runOtherMonitorCron(_controller, _env, _ctx, options) {
      assert.equal(options.deferSuccess, true);
      events.push('monitor-run');
    },
  });

  assert.deepEqual(events, [
    'recovery-run', 'recovery-ack',
    'gate-run-rebuild', 'gate-ack',
    'monitor-run', 'monitor-ack',
  ]);
});

test('runtime Queue handler executes maintenance and preserves ack ownership', async () => {
  const events = [];
  const message = queueMessage({
    message_type: MONITOR_MAINTENANCE_MESSAGE,
    cron: ROLLUP_MAINTENANCE_CRON,
    scheduled_at: BASE + 30 * 60_000,
  }, events);

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
        queueMessage({
          message_type: MONITOR_MAINTENANCE_MESSAGE,
          cron: ROLLUP_MAINTENANCE_CRON,
          scheduled_at: BASE + 30 * 60_000,
        }, events, 'maintenance-'),
        queueMessage({ message_type: 'unsupported-monitor-message' }, events, 'other-'),
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
      messages: [queueMessage({ message_type: 'minute-fact-derive' }, events)],
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
        messages: [queueMessage({
          message_type: MONITOR_MAINTENANCE_MESSAGE,
          cron: SNAPSHOT_RETENTION_CRON,
          scheduled_at: BASE + 50 * 60_000,
        }, events)],
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
