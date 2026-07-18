import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import minuteDeriveWorker from '../src/minute-derive-entry.js';

test('minute derive deployment guarantees one message per invocation', async () => {
  const config = await readFile(new URL('../wrangler.minute-derive.jsonc', import.meta.url), 'utf8');
  assert.match(config, /"max_batch_size"\s*:\s*1\b/);
});

test('single-message derive batches avoid generic collection setup', async () => {
  let acknowledged = 0;
  const messages = new Proxy([{
    body: {},
    ack() { acknowledged += 1; },
    retry() { assert.fail('invalid derive triggers must not retry'); },
  }], {
    get(target, property, receiver) {
      if (property === 'length' || property === Symbol.iterator) {
        assert.fail(`minute derive batch accessed ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
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
