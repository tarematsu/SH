import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { processMinuteRebuildBatch } from '../src/minute-rebuild-batched-entry.js';

function queueMessage(id, body, events) {
  return {
    body,
    ack() { events.push(`ack:${id}`); },
    retry(options) { events.push(`retry:${id}:${options?.delaySeconds ?? 0}`); },
  };
}

test('mixed maintenance and rebuild messages keep independent ack handling', async () => {
  const events = [];
  const calls = [];
  const messages = [
    queueMessage(1, {
      message_type: 'minute-rebuild-stage',
      message_version: 1,
      stage: 'maintenance-gate',
      maintenance_task: 'rebuild',
    }, events),
    queueMessage(2, {
      message_type: 'minute-rebuild-stage',
      message_version: 1,
      stage: 'gap-scan',
    }, events),
  ];
  await processMinuteRebuildBatch({ messages }, {}, null, {
    async processMinuteMaintenanceGate() {
      calls.push('maintenance');
      return { stage: 'maintenance-gate', task: 'rebuild', run_id: 'm1' };
    },
    async processMinuteRebuildStage() {
      calls.push('rebuild');
      return { stage: 'gap-scan', run_id: 'r1' };
    },
  });
  assert.deepEqual(calls, ['maintenance', 'rebuild']);
  assert.deepEqual(events, ['ack:1', 'ack:2']);
});

test('one failed message retries without discarding a successful sibling', async () => {
  const events = [];
  let calls = 0;
  const messages = [
    queueMessage(1, { message_type: 'minute-rebuild-stage', message_version: 1, stage: 'gap-scan' }, events),
    queueMessage(2, { message_type: 'minute-rebuild-stage', message_version: 1, stage: 'gap-commit' }, events),
  ];
  const originalError = console.error;
  console.error = () => {};
  try {
    await processMinuteRebuildBatch({ messages }, {}, null, {
      async processMinuteRebuildStage() {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return { stage: 'gap-commit', run_id: 'r2' };
      },
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(events, ['retry:1:60', 'ack:2']);
});

test('runtime rebuild delivery is capped at two messages', () => {
  const config = JSON.parse(readFileSync(
    new URL('../wrangler.runtime.jsonc', import.meta.url),
    'utf8',
  ));
  const rebuild = config.queues.consumers.find(({ queue }) => queue === 'stationhead-minute-rebuild');
  assert.equal(config.main, 'src/runtime-orchestrator-entry.js');
  assert.equal(rebuild.max_batch_size, 2);
  assert.equal(rebuild.max_concurrency, 1);
});
