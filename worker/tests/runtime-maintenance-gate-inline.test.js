import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUNTIME_CRON,
  RUNTIME_MINUTE_GATE_MESSAGE,
  runRuntimeScheduled,
} from '../src/runtime-scheduled.js';

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const MAINTENANCE_CRON = '5,7,9,15,17,19,25,27,29,35,37,39,45,47,49,55,57,59 * * * *';

test('runtime Cron sends the minute maintenance gate directly to its dedicated Queue', async () => {
  const hostBatches = [];
  const gateCalls = [];
  const scheduledAt = BASE + 37 * 60_000;
  const result = await runRuntimeScheduled(
    { cron: RUNTIME_CRON, scheduledTime: scheduledAt },
    { HOST_MONITOR_QUEUE: { async sendBatch(messages) { hostBatches.push(messages); } } },
    null,
    {
      async dispatchRawCollection() {},
      async dispatchMinuteMaintenanceGate(controller, _env, task) {
        gateCalls.push({ controller, task });
        return { dispatched: true };
      },
    },
  );

  assert.deepEqual(hostBatches, []);
  assert.deepEqual(gateCalls, [{
    controller: { cron: MAINTENANCE_CRON, scheduledTime: scheduledAt },
    task: 'rebuild',
  }]);
  assert.deepEqual(result.map(({ task }) => task), ['raw-collection', 'minute-rebuild']);
});

test('a direct minute maintenance gate failure falls back to the relay Queue', async () => {
  const hostBatches = [];
  const warnings = [];
  const scheduledAt = BASE + 39 * 60_000;
  const originalWarn = console.warn;
  console.warn = (value) => warnings.push(String(value));
  try {
    await runRuntimeScheduled(
      { cron: RUNTIME_CRON, scheduledTime: scheduledAt },
      { HOST_MONITOR_QUEUE: { async sendBatch(messages) { hostBatches.push(messages); } } },
      null,
      {
        async dispatchRawCollection() {},
        async dispatchMinuteMaintenanceGate() {
          throw new Error('temporary rebuild Queue failure');
        },
      },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(hostBatches.flat().map(({ body }) => body), [{
    message_type: RUNTIME_MINUTE_GATE_MESSAGE,
    message_version: 1,
    task: 'sync',
    scheduled_at: scheduledAt,
  }]);
  assert.match(warnings.join('\n'), /inline_minute_maintenance_gate_failed/);
});
