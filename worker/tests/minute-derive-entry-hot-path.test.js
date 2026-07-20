import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import minuteDeriveWorker, { processMinuteDeriveBatch } from '../src/minute-derive-entry.js';

test('runtime deployment isolates recovery and live derive deliveries', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.runtime.jsonc', import.meta.url), 'utf8'));
  const consumers = new Map(config.queues.consumers.map((consumer) => [consumer.queue, consumer]));
  assert.equal(consumers.get('stationhead-minute-derive').max_batch_size, 1);
  assert.equal(consumers.get('stationhead-minute-live-derive').max_batch_size, 1);
  assert.equal(consumers.get('stationhead-minute-live-derive').max_concurrency, 2);
  assert.deepEqual(Object.keys(minuteDeriveWorker), ['queue']);
});

test('single-message derive deliveries keep independent acknowledgement', async () => {
  const events = [];
  await processMinuteDeriveBatch({ messages: [{
    body: { id: 1 },
    ack() { events.push('ack'); },
    retry() { events.push('retry'); },
  }] }, {}, {
    processMessage: async () => ({ processed: 1, failed: 0, job_id: 1 }),
  });
  assert.deepEqual(events, ['ack']);
});
