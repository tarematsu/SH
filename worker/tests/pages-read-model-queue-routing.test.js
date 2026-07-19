import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MINUTE_READ_MODEL_QUEUE,
  runPagesReadModelQueue,
} from '../src/pages-read-model-entry.js';

test('stale minute read-model consumers delegate without treating messages as publication tasks', async () => {
  const calls = [];
  const batch = {
    queue: MINUTE_READ_MODEL_QUEUE,
    messages: [{ body: { message_type: 'stationhead-read-model' } }],
  };
  const env = { MINUTE_DB: {}, TRACK_METADATA_QUEUE: {} };
  const result = { routed: true };

  assert.equal(await runPagesReadModelQueue(batch, env, {
    processReadModelBatch: async (...args) => {
      calls.push(args);
      return result;
    },
    processTrackHistoryPublicationTask: async () => {
      throw new Error('publication handler must not run');
    },
  }), result);
  assert.deepEqual(calls, [[batch, env]]);
});

test('publication queue messages keep the existing ack path', async () => {
  let acked = 0;
  let retried = 0;
  const batch = {
    queue: 'stationhead-pages-read-model-publication',
    messages: [{
      body: { task: 'track-history-publication' },
      ack() { acked += 1; },
      retry() { retried += 1; },
    }],
  };

  await runPagesReadModelQueue(batch, {}, {
    processTrackHistoryPublicationTask: async () => ({ ok: true }),
    processReadModelBatch: async () => {
      throw new Error('minute handler must not run');
    },
  });

  assert.equal(acked, 1);
  assert.equal(retried, 0);
});
