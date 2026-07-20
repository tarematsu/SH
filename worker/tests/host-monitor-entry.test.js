import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { processHostMonitorTask } from '../src/host-monitor-entry.js';
import {
  OTHER_MONITOR_CRON,
  runOtherMonitorQueue,
  runOtherMonitorScheduled,
} from '../src/other-monitor-entry.js';

function message(body, calls) {
  return {
    body,
    ack() { calls.push('ack'); },
    retry() { calls.push('retry'); },
  };
}

test('host work is deferred to one Queue invocation in the runtime Worker', async () => {
  const sent = [];
  const result = await runOtherMonitorScheduled(
    { cron: OTHER_MONITOR_CRON, scheduledTime: Date.UTC(2026, 0, 1, 0, 25) },
    { HOST_MONITOR_QUEUE: { async send(body) { sent.push(body); } } },
    {},
    { officialNewsDue: async () => false, host: async () => assert.fail('host must be deferred') },
  );
  assert.equal(result[0].dispatched, true);
  assert.equal(result[0].task, 'host');
  assert.equal(sent[0].message_type, 'host-monitor-task');
});

test('host task validation and execution remain isolated per Queue invocation', async () => {
  const calls = [];
  const result = await processHostMonitorTask({ OTHER_DB: {} }, {
    message_type: 'host-monitor-task',
    message_version: 1,
    scheduled_at: 123_000,
    observed_at: 123_456,
  }, { run: async (env) => calls.push(env) });
  assert.equal(calls.length, 1);
  assert.equal(result.event, 'host_monitor_task_completed');
  assert.equal(result.scheduled_at, 123_000);
});

test('runtime Worker consumes host, buddy, and minute queues with independent limits', () => {
  const runtime = JSON.parse(readFileSync(new URL('../wrangler.runtime.jsonc', import.meta.url), 'utf8'));
  assert.equal(runtime.name, 'sh-runtime-orchestrator');
  assert.equal(runtime.queues.producers.some(({ binding }) => binding === 'HOST_MONITOR_QUEUE'), true);
  assert.equal(runtime.queues.producers.some(({ binding }) => binding === 'BUDDY_PLAYBACK_QUEUE'), true);
  assert.deepEqual(runtime.queues.consumers.map(({ queue }) => queue), [
    'stationhead-buddy-playback',
    'stationhead-host-monitor',
    'stationhead-minute-derive',
    'stationhead-minute-live-derive',
    'stationhead-buddies-facts',
    'stationhead-minute-rebuild',
  ]);
  const limits = new Map(runtime.queues.consumers.map((consumer) => [consumer.queue, consumer]));
  for (const queue of [
    'stationhead-buddy-playback',
    'stationhead-host-monitor',
    'stationhead-minute-derive',
    'stationhead-buddies-facts',
  ]) {
    assert.equal(limits.get(queue).max_batch_size, 1);
    assert.equal(limits.get(queue).max_concurrency, 1);
  }
  assert.equal(limits.get('stationhead-minute-live-derive').max_batch_size, 2);
  assert.equal(limits.get('stationhead-minute-live-derive').max_concurrency, 2);
  assert.equal(limits.get('stationhead-minute-rebuild').max_batch_size, 2);
  assert.equal(limits.get('stationhead-minute-rebuild').max_concurrency, 1);
});

test('monitor Queue router rejects unknown task types without acknowledging them', async () => {
  const calls = [];
  await runOtherMonitorQueue({ messages: [message({ message_type: 'unknown' }, calls)] }, {});
  assert.deepEqual(calls, ['retry']);
});
