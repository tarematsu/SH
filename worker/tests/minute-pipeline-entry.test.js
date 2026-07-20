import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIVE_DERIVE_QUEUE_NAME,
  MINUTE_FACTS_QUEUE_NAME,
  processMinutePipelineBatch,
  REBUILD_DERIVE_QUEUE_NAME,
} from '../src/minute-pipeline-entry.js';

test('facts Queue is delegated to the production handler without taking ack ownership', async () => {
  const calls = [];
  const batch = { queue: MINUTE_FACTS_QUEUE_NAME, messages: [{ ack() { calls.push('ack'); } }] };
  const result = await processMinutePipelineBatch(batch, { MINUTE_DB: {} }, {}, {
    consumeMinuteQueue(receivedBatch, env, ctx) {
      calls.push([receivedBatch.queue, env, ctx]);
      return { handled: 'facts' };
    },
  });

  assert.deepEqual(result, { handled: 'facts' });
  assert.equal(calls[0][0], MINUTE_FACTS_QUEUE_NAME);
  assert.equal(calls.length, 1);
});

test('both derive Queue lanes are delegated to the derive handler', async () => {
  const seen = [];
  for (const queue of [REBUILD_DERIVE_QUEUE_NAME, LIVE_DERIVE_QUEUE_NAME]) {
    await processMinutePipelineBatch({ queue, messages: [] }, {}, {}, {
      derive: {
        processMessage: async () => ({ processed: 0 }),
      },
    });
    seen.push(queue);
  }
  assert.deepEqual(seen, [REBUILD_DERIVE_QUEUE_NAME, LIVE_DERIVE_QUEUE_NAME]);
});

test('unknown Queue names fail before any message can be acknowledged', async () => {
  const calls = [];
  await assert.rejects(
    processMinutePipelineBatch({ queue: 'stationhead-unknown', messages: [{ ack() { calls.push('ack'); } }] }, {}, {}),
    /Unsupported minute pipeline queue/,
  );
  assert.deepEqual(calls, []);
});
