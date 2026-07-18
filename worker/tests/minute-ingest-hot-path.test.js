import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeMinuteQueue } from '../src/minute-production-entry.js';

test('minute ingest composes inbox acceptance and derive handoff in order', async () => {
  const batch = { messages: [{ body: { job_id: 'minute-fact:10:20' } }] };
  const env = { MINUTE_DB: {} };
  const calls = [];
  let handlers = null;

  const result = await consumeMinuteQueue(batch, env, null, {
    consumeMinuteFactBatch: async (activeBatch, activeEnv, value) => {
      assert.equal(activeBatch, batch);
      assert.equal(activeEnv, env);
      handlers = value;
      return { received: 1 };
    },
    enqueueMinuteFactJob: async (activeEnv, payload, options) => {
      calls.push(['inbox', activeEnv, payload, options]);
      return { jobId: 'minute-fact:10:20', created: true };
    },
    enqueueMinuteDeriveTrigger: async (activeEnv, accepted) => {
      calls.push(['derive', activeEnv, accepted]);
    },
  });

  assert.deepEqual(result, { received: 1 });
  const payload = { observedAt: 20 };
  const options = { jobKind: 'live' };
  const accepted = await handlers.enqueue(env, payload, options);

  assert.deepEqual(accepted, { jobId: 'minute-fact:10:20', created: true });
  assert.deepEqual(calls.map(([kind]) => kind), ['inbox', 'derive']);
  assert.equal(calls[1][2], accepted);
});
