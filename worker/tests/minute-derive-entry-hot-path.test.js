import assert from 'node:assert/strict';
import test from 'node:test';

import minuteDeriveWorker from '../src/minute-derive-entry.js';

test('single-message derive batches avoid array iterator setup', async () => {
  let acknowledged = 0;
  const messages = [{
    body: {},
    ack() { acknowledged += 1; },
    retry() { assert.fail('invalid derive triggers must not retry'); },
  }];
  Object.defineProperty(messages, Symbol.iterator, {
    configurable: true,
    get() { throw new Error('minute derive batch iterator was accessed'); },
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
