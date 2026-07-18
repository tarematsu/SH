import assert from 'node:assert/strict';
import test from 'node:test';

import {
  minuteDeriveTrigger,
  processMinuteDeriveCompleteStage,
  processMinuteDeriveTrigger,
  processMinuteDeriveWriteStage,
} from '../src/minute-derive-queue.js';

const trigger = minuteDeriveTrigger({ channel_id: 10, minute_at: 120_000 });
const payload = {
  payload_version: 1,
  observedAt: 123_456,
  snapshot: { channel_id: 10 },
  queue: null,
  comments: {},
  rebuild: null,
};
const claimedJob = {
  id: 7,
  channel_id: 10,
  minute_at: 120_000,
  payload_version: 1,
  payload_json: JSON.stringify(payload),
  job_kind: 'live',
  attempts: 1,
};

test('derive claim durably hands write work to the same ordered Queue', async () => {
  const sent = [];
  const result = await processMinuteDeriveTrigger({
    MINUTE_DB: {},
    MINUTE_DERIVE_QUEUE: { async send(body) { sent.push(body); } },
  }, trigger, {
    now: () => 200_000,
    claim: async () => claimedJob,
  });

  assert.equal(result.event, 'minute_fact_derive_claimed');
  assert.equal(result.pending, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_type, 'minute-fact-derive-stage');
  assert.equal(sent[0].stage, 'write');
  assert.deepEqual(sent[0].payload, payload);
});

test('derive write hands completion to a separate Queue invocation', async () => {
  const calls = [];
  const sent = [];
  const result = await processMinuteDeriveWriteStage({
    MINUTE_DB: {},
    MINUTE_DERIVE_QUEUE: { async send(body) { sent.push(body); } },
  }, {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'write',
    job: claimedJob,
    payload,
    started_at: 200_000,
  }, {
    write: async (_env, value) => calls.push(`write:${value.snapshot.channel_id}`),
  });

  assert.deepEqual(calls, ['write:10']);
  assert.equal(result.event, 'minute_fact_derive_write');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, 'complete');
  assert.equal(sent[0].job.id, 7);
});

test('derive write failure returns the durable job to pending without retrying the stage message', async () => {
  let failed = null;
  const result = await processMinuteDeriveWriteStage({ MINUTE_DB: {} }, {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'write',
    job: { ...claimedJob, attempts: 2 },
    payload,
    started_at: 200_000,
  }, {
    now: () => 200_000,
    write: async () => { throw new Error('D1 unavailable'); },
    fail: async (_env, job, error, options) => {
      failed = { job, error, options };
      return { terminal: false };
    },
  });

  assert.equal(result.failed, 1);
  assert.equal(result.retry_message, false);
  assert.equal(result.retry_delay_ms, 120_000);
  assert.equal(failed.job.id, 7);
});

test('derive completion marks the job done in its own invocation', async () => {
  const calls = [];
  const result = await processMinuteDeriveCompleteStage({ MINUTE_DB: {} }, {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'complete',
    job: claimedJob,
    started_at: 199_000,
  }, {
    now: () => 200_000,
    complete: async (_env, id, now) => calls.push({ id, now }),
  });

  assert.deepEqual(calls, [{ id: 7, now: 200_000 }]);
  assert.equal(result.processed, 1);
  assert.equal(result.duration_ms, 1_000);
});
