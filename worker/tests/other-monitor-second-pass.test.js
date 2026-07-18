import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  OTHER_MONITOR_CRON,
  runOtherMonitorCron,
  runOtherMonitorQueue,
  runOtherMonitorScheduled,
} from '../src/other-monitor-entry.js';

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

function queueSink(sent) {
  return {
    async send(body, options) {
      sent.push({ body, options });
    },
  };
}

test('production prediction and host selection are deferred to the host queue', async () => {
  const sent = [];
  const env = { HOST_MONITOR_QUEUE: queueSink(sent) };

  const prediction = await runOtherMonitorScheduled(
    { cron: OTHER_MONITOR_CRON, scheduledTime: BASE + 10 * 60_000 },
    env,
    {},
  );
  assert.equal(prediction[0].dispatched, true);
  assert.equal(sent[0].body.message_type, 'other-monitor-task');
  assert.equal(sent[0].body.task, 'prediction');

  sent.length = 0;
  const host = await runOtherMonitorScheduled(
    { cron: OTHER_MONITOR_CRON, scheduledTime: BASE + 25 * 60_000 },
    env,
    {},
  );
  assert.equal(host[0].dispatched, true);
  assert.equal(sent[0].body.message_type, 'other-monitor-select');
});

test('production Cron defers its heartbeat after dispatch', async () => {
  const sent = [];
  const env = { HOST_MONITOR_QUEUE: queueSink(sent) };
  await runOtherMonitorCron(
    { cron: OTHER_MONITOR_CRON, scheduledTime: BASE + 10 * 60_000 },
    env,
    {},
  );
  assert.deepEqual(sent.map(({ body }) => body.message_type), [
    'other-monitor-task',
    'other-monitor-success',
  ]);
});

test('host selection runs the due probe in its own invocation', async () => {
  const sent = [];
  let acknowledged = 0;
  const env = {
    HOST_MONITOR_QUEUE: queueSink(sent),
    OTHER_DB: {
      prepare() {
        return {
          bind() { return this; },
          async first() { return null; },
        };
      },
    },
  };
  await runOtherMonitorQueue({ messages: [{
    body: { message_type: 'other-monitor-select', scheduled_at: BASE + 25 * 60_000 },
    ack() { acknowledged += 1; },
    retry() { assert.fail('selection must not retry'); },
  }] }, env, {});
  assert.equal(acknowledged, 1);
  assert.equal(sent[0].body.message_type, 'host-monitor-task');
});

test('other monitor support caches official-news modules and avoids eager fallback time', () => {
  const support = readFileSync(new URL('../src/other-monitor-support.js', import.meta.url), 'utf8');
  assert.match(support, /officialNewsProbeModulePromise \|\|=/);
  assert.match(support, /officialNewsReconcileModulePromise \|\|=/);
  assert.match(support, /officialNewsUtilsModulePromise \|\|=/);
  assert.match(support, /return fallback \?\? Date\.now\(\)/);
  assert.doesNotMatch(support, /scheduledTimestamp\(controller, fallback = Date\.now\(\)\)/);
});
