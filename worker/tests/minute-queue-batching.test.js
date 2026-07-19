import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  LIVE_DERIVE_QUEUE_NAME,
  processMinuteDeriveBatch,
} from '../src/minute-derive-entry.js';
import { processMinuteRebuildBatch } from '../src/minute-rebuild-entry.js';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

function queueMessage(id, events) {
  return {
    body: { id },
    ack() { events.push(`ack:${id}`); },
    retry() { events.push(`retry:${id}`); },
  };
}

test('derive processes and acknowledges every message in a two-message delivery', async () => {
  const events = [];
  const processed = [];
  const messages = [queueMessage(1, events), queueMessage(2, events)];
  await processMinuteDeriveBatch({ queue: LIVE_DERIVE_QUEUE_NAME, messages }, {
    MINUTE_LIVE_DERIVE_QUEUE: { send() {} },
    MINUTE_DERIVE_QUEUE: { send() {} },
  }, {
    async processMessage(_env, body) {
      processed.push(body.id);
      return { processed: 1, failed: 0, job_id: body.id };
    },
  });
  assert.deepEqual(processed, [1, 2]);
  assert.deepEqual(events, ['ack:1', 'ack:2']);
});

test('rebuild processes and acknowledges every message in a two-message delivery', async () => {
  const events = [];
  const processed = [];
  const messages = [queueMessage(1, events), queueMessage(2, events)];
  await processMinuteRebuildBatch({ messages }, {}, {
    async processStage(_env, body) {
      processed.push(body.id);
      return { stage: 'test', run_id: String(body.id), pending: false };
    },
  });
  assert.deepEqual(processed, [1, 2]);
  assert.deepEqual(events, ['ack:1', 'ack:2']);
});

test('production derive and rebuild queues deliver pairs conservatively', () => {
  const derive = config('wrangler.minute-derive.jsonc');
  const rebuild = config('wrangler.minute-rebuild.jsonc');
  assert.deepEqual(derive.queues.consumers.map(({ max_batch_size }) => max_batch_size), [2, 2]);
  assert.equal(rebuild.queues.consumers[0].max_batch_size, 2);
});
