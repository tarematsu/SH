import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import minuteDeriveWorker from '../src/minute-derive-entry.js';

test('minute derive deployment guarantees one message per invocation', async () => {
  const config = await readFile(new URL('../wrangler.minute-derive.jsonc', import.meta.url), 'utf8');
  assert.match(config, /"max_batch_size"\s*:\s*1\b/);
  assert.deepEqual(Object.keys(minuteDeriveWorker), ['queue']);
});

test('single-message derive batches avoid iterator and loop setup', async () => {
  let acknowledged = 0;
  const messages = [{
    body: {},
    ack() { acknowledged += 1; },
    retry() { assert.fail('invalid derive triggers must not retry'); },
  }, {
    get body() { assert.fail('single-message dispatch must not read a second body'); },
    ack() { assert.fail('single-message dispatch must not acknowledge a second message'); },
    retry() { assert.fail('single-message dispatch must not retry a second message'); },
  }];
  Object.defineProperty(messages, Symbol.iterator, {
    configurable: true,
    get() { assert.fail('minute derive batch iterator was accessed'); },
  });

  const originalError = console.error;
  console.error = () => {};
  try {
    await minuteDeriveWorker.queue({ messages }, {});
  } finally {
    console.error = originalError;
  }

  assert.equal(acknowledged, 1);
});
