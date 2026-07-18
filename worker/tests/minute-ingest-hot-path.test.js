import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { consumeMinuteQueue } from '../src/minute-production-entry.js';

const source = readFileSync(new URL('../src/minute-production-entry.js', import.meta.url), 'utf8');

test('production minute ingest uses direct warm-path functions and stable handlers', () => {
  assert.match(source, /const EMPTY_DEPENDENCIES = Object\.freeze\(\{\}\)/);
  assert.match(source, /const SKIPPED_COMMENT_TASK = Object\.freeze\(\{ created: false, skipped: true \}\)/);
  assert.match(source, /const PRODUCTION_HANDLERS = Object\.freeze\(\{/);
  assert.match(source, /productionModulesPromise \|\|= Promise\.all\(\[/);
  assert.match(source, /function consumeProductionMinuteQueue\(batch, env\)/);
  assert.match(source, /queue: consumeProductionMinuteQueue/);
  assert.match(source, /function saveDefaultReadModels\(activeEnv, readModel, jobId\)/);
  assert.doesNotMatch(source, /async function (?:consumeProductionMinuteQueue|saveDefaultReadModels)/);
  assert.doesNotMatch(source, /Promise\.resolve\(null\)/);
  assert.doesNotMatch(source, /async function (?:noReceipt|ignoreReceipt|skipCommentTask)/);
});

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
  assert.equal(handlers.saveCommentTask(), handlers.saveCommentTask());
});

test('default rollout no-op avoids an extra Promise on the normal null read-model path', async () => {
  let handlers = null;
  await consumeMinuteQueue({ messages: [] }, {}, null, {
    consumeMinuteFactBatch: async (_batch, _env, value) => {
      handlers = value;
      return { received: 0 };
    },
    enqueueMinuteFactJob: async () => ({ jobId: 'unused' }),
  });

  assert.equal(handlers.saveReadModels({}, null, 'missing'), undefined);
});

test('dependency-injected rollout read-model handling remains compatible', async () => {
  const saved = [];
  let handlers = null;
  await consumeMinuteQueue({ messages: [] }, {}, null, {
    consumeMinuteFactBatch: async (_batch, _env, value) => {
      handlers = value;
      return { received: 0 };
    },
    enqueueMinuteFactJob: async () => ({ jobId: 'unused' }),
    saveMinuteFactReadModels: async (...args) => saved.push(args),
  });

  await handlers.saveReadModels({}, null, 'missing');
  const readModel = { channel: { channel_id: 10 } };
  await handlers.saveReadModels({ MINUTE_DB: {} }, readModel, 'read-model:10:20');

  assert.equal(saved.length, 1);
  assert.equal(saved[0][1], readModel);
  assert.equal(saved[0][2], 'read-model:10:20');
});
