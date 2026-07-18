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

test('host work is deferred to one Queue invocation in the same Worker script', async () => {
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

test('one monitor Worker consumes host and buddy queues with independent limits', () => {
  const other = JSON.parse(readFileSync(new URL('../wrangler.other.jsonc', import.meta.url), 'utf8'));
  assert.equal(other.name, 'sh-monitor-other');
  assert.equal(other.queues.producers.some(({ binding }) => binding === 'HOST_MONITOR_QUEUE'), true);
  assert.equal(other.queues.producers.some(({ binding }) => binding === 'BUDDY_PLAYBACK_QUEUE'), true);
  assert.deepEqual(other.queues.consumers.map(({ queue }) => queue), [
    'stationhead-buddy-playback',
    'stationhead-host-monitor',
  ]);
  for (const consumer of other.queues.consumers) {
    assert.equal(consumer.max_batch_size, 1);
    assert.equal(consumer.max_concurrency, 1);
  }
});

test('consolidated Queue router rejects unknown task types without acknowledging them', async () => {
  const calls = [];
  await runOtherMonitorQueue({ messages: [message({ message_type: 'unknown' }, calls)] }, {});
  assert.deepEqual(calls, ['retry']);
});
