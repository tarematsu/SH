import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUDGET_LIVE_WRITE_STAGE,
  processBudgetedLiveWriteBatch,
  processBudgetedLiveWriteMessage,
} from '../src/minute-live-write-budget-entry.js';

function validWriteBody() {
  return {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'write',
    job: { id: 42, job_kind: 'live', payload_version: 1 },
    payload: { payload_version: 1, snapshot: {}, queue: null },
    started_at: 100,
  };
}

test('valid live write preparation emits the bounded commit continuation', async () => {
  const sent = [];
  const result = await processBudgetedLiveWriteMessage({}, validWriteBody(), {
    materializer: {
      shouldMaterializeLiveRevision() { return false; },
    },
    async sendStage(body) { sent.push(body); },
  });
  assert.deepEqual(result, { prepared: true, revision_id: null });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, BUDGET_LIVE_WRITE_STAGE);
  assert.equal(sent[0].job.id, 42);
});

test('malformed live write messages are acknowledged instead of retried forever', async () => {
  const events = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    await processBudgetedLiveWriteBatch({
      messages: [{
        body: { ...validWriteBody(), job: {} },
        ack() { events.push('ack'); },
        retry() { events.push('retry'); },
      }],
    }, {});
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(events, ['ack']);
});

test('transient live write failures still retry with a bounded delay', async () => {
  const events = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    await processBudgetedLiveWriteBatch({
      messages: [{
        body: validWriteBody(),
        ack() { events.push('ack'); },
        retry(options) { events.push(['retry', options]); },
      }],
    }, {}, {
      materializer: {
        shouldMaterializeLiveRevision() { return false; },
      },
      async sendStage() { throw new Error('Queue unavailable'); },
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(events, [['retry', { delaySeconds: 60 }]]);
});
