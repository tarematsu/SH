import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import minuteDeriveWorker, { processMinuteDeriveBatch } from '../src/minute-derive-entry.js';

test('minute derive deployment bounds deliveries to two messages', async () => {
  const config = await readFile(new URL('../wrangler.minute-derive.jsonc', import.meta.url), 'utf8');
  assert.match(config, /"max_batch_size"\s*:\s*2\b/);
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
