import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { processHostMonitorTask } from '../src/host-monitor-entry.js';
import { OTHER_MONITOR_CRON, runOtherMonitorScheduled } from '../src/other-monitor-entry.js';

test('host work is deferred to one dedicated Queue invocation', async () => {
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

test('dedicated host Worker validates and runs exactly one task', async () => {
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

test('host topology has one producer and one single-message consumer', () => {
  const other = JSON.parse(readFileSync(new URL('../wrangler.other.jsonc', import.meta.url), 'utf8'));
  const host = JSON.parse(readFileSync(new URL('../wrangler.host-monitor.jsonc', import.meta.url), 'utf8'));
  assert.equal(other.queues.producers.some(({ binding }) => binding === 'HOST_MONITOR_QUEUE'), true);
  assert.equal(host.name, 'sh-host-monitor');
  assert.equal(host.queues.consumers[0].queue, 'stationhead-host-monitor');
  assert.equal(host.queues.consumers[0].max_batch_size, 1);
  assert.equal(host.triggers, undefined);
});
