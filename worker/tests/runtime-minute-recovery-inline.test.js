import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUNTIME_CRON,
  RUNTIME_MINUTE_RECOVERY_MESSAGE,
  runRuntimeScheduled,
} from '../src/runtime-scheduled.js';

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

test('runtime Cron runs minute recovery directly without the host-monitor relay', async () => {
  const hostBatches = [];
  const recoveryCalls = [];
  const scheduledAt = BASE + 36 * 60_000;
  const ctx = { waitUntil() {} };
  const env = {
    HOST_MONITOR_QUEUE: {
      async sendBatch(messages) {
        hostBatches.push(messages);
      },
    },
  };

  const result = await runRuntimeScheduled(
    { cron: RUNTIME_CRON, scheduledTime: scheduledAt },
    env,
    ctx,
    {
      async dispatchRawCollection() {},
      async dispatchPendingMinuteFacts(activeEnv, dependencies, activeCtx) {
        recoveryCalls.push({ activeEnv, dependencies, activeCtx });
        return { dispatched: 0 };
      },
      minuteDispatchDependencies: { marker: 'recovery' },
    },
  );

  assert.deepEqual(hostBatches, []);
  assert.deepEqual(recoveryCalls, [{
    activeEnv: env,
    dependencies: { marker: 'recovery' },
    activeCtx: ctx,
  }]);
  assert.deepEqual(result.map(({ task }) => task), ['raw-collection', 'minute-recovery']);
});

test('a direct minute recovery failure falls back to the relay Queue', async () => {
  const hostBatches = [];
  const warnings = [];
  const scheduledAt = BASE + 36 * 60_000;
  const originalWarn = console.warn;
  console.warn = (value) => warnings.push(String(value));
  try {
    await runRuntimeScheduled(
      { cron: RUNTIME_CRON, scheduledTime: scheduledAt },
      {
        HOST_MONITOR_QUEUE: {
          async sendBatch(messages) {
            hostBatches.push(messages);
          },
        },
      },
      null,
      {
        async dispatchRawCollection() {},
        async dispatchPendingMinuteFacts() {
          throw new Error('temporary derive dispatch failure');
        },
      },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(hostBatches.flat().map(({ body }) => body), [{
    message_type: RUNTIME_MINUTE_RECOVERY_MESSAGE,
    message_version: 1,
    scheduled_at: scheduledAt,
  }]);
  assert.match(warnings.join('\n'), /inline_minute_recovery_failed/);
});
