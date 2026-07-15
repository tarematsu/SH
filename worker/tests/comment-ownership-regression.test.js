import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { collectOptionalComments } from '../src/collector-comments.js';
import {
  consumeMinuteFactBatch,
  minuteFactQueueMessage,
} from '../src/minute-facts-queue.js';

test('buddies comment collection rethrows the primary watchdog abort', async () => {
  const controller = new AbortController();
  const timeout = new Error('primary watchdog expired');
  timeout.code = 'PRIMARY_COLLECTION_TIMEOUT';
  let warned = false;

  await assert.rejects(collectOptionalComments(
    {},
    { stationId: 42 },
    { chatLimit: 50, collectionSignal: controller.signal },
    1_700_000_000_000,
    {
      requestJson: async () => {
        controller.abort(timeout);
        throw new DOMException('aborted', 'AbortError');
      },
      writeIngest: async () => {
        throw new Error('comment ingest must not run after abort');
      },
      warn: () => { warned = true; },
    },
  ), (error) => error === timeout);

  assert.equal(warned, false);
});

test('minute Queue has no default path that recreates retired comment tasks', async () => {
  const source = readFileSync(new URL('../src/minute-facts-queue.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\/minute-comments\.js['"]/);

  const calls = [];
  const body = minuteFactQueueMessage({
    observedAt: 123_456,
    snapshot: { channel_id: 10, station_id: 42 },
    comments: { degraded: false },
  }, { collectComments: true });
  const message = {
    id: 'legacy-comment-message',
    attempts: 1,
    body,
    ack() { calls.push('ack'); },
    retry() { calls.push('retry'); },
  };

  const result = await consumeMinuteFactBatch({ messages: [message] }, {}, {
    hasReceipt: async () => false,
    enqueue: async () => ({ enqueued: true }),
    saveReadModels: async () => {},
    saveReceipt: async () => {},
  });

  assert.deepEqual(result, {
    received: 1,
    enqueued: 1,
    duplicates: 0,
    retried: 0,
    invalid: 0,
  });
  assert.deepEqual(calls, ['ack']);
});
