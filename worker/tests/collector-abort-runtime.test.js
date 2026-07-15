import assert from 'node:assert/strict';
import test from 'node:test';

import {
  throwIfCollectionAborted,
  withAbortableD1,
} from '../src/collector-runner.js';
import {
  PrimaryCollectionTimeoutError,
  COLLECTION_ABORT_SIGNAL,
  COLLECTION_DEADLINE_AT,
  runPrimaryScheduled,
  withCollectionRuntime,
} from '../src/main-scheduler.js';

function context() {
  const tasks = [];
  return {
    tasks,
    waitUntil(task) { tasks.push(Promise.resolve(task)); },
  };
}

test('collection runtime inherits bindings without sharing request metadata', () => {
  const baseEnv = {
    DB: { name: 'buddies' },
    CHANNEL_ALIAS: 'buddies',
    MINUTE_FACT_QUEUE: { send() {} },
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const firstDeadline = 123;
  const secondDeadline = 456;
  const first = withCollectionRuntime(baseEnv, firstController.signal, firstDeadline);
  const second = withCollectionRuntime(baseEnv, secondController.signal, secondDeadline);

  assert.notEqual(first, baseEnv);
  assert.equal(first.DB, baseEnv.DB);
  assert.equal(first.CHANNEL_ALIAS, baseEnv.CHANNEL_ALIAS);
  assert.equal(first.MINUTE_FACT_QUEUE, baseEnv.MINUTE_FACT_QUEUE);
  assert.equal(first[COLLECTION_ABORT_SIGNAL], firstController.signal);
  assert.equal(first[COLLECTION_DEADLINE_AT], firstDeadline);
  assert.equal(COLLECTION_ABORT_SIGNAL in first, true);
  assert.equal(COLLECTION_DEADLINE_AT in first, true);
  assert.equal(Object.hasOwn(baseEnv, COLLECTION_ABORT_SIGNAL), false);
  assert.equal(Object.hasOwn(baseEnv, COLLECTION_DEADLINE_AT), false);
  assert.equal(second[COLLECTION_ABORT_SIGNAL], secondController.signal);
  assert.equal(second[COLLECTION_DEADLINE_AT], secondDeadline);

  firstController.abort(new Error('first request only'));
  assert.equal(first[COLLECTION_ABORT_SIGNAL].aborted, true);
  assert.equal(second[COLLECTION_ABORT_SIGNAL].aborted, false);
});

test('primary watchdog aborts the request-scoped collection signal', async () => {
  const ctx = context();
  let observedSignal = null;
  const run = runPrimaryScheduled(
    { cron: '* * * * *' },
    {},
    ctx,
    (_controller, env) => {
      observedSignal = env.__COLLECTION_ABORT_SIGNAL;
      return new Promise((resolve, reject) => {
        observedSignal.addEventListener('abort', () => reject(observedSignal.reason), { once: true });
      });
    },
    10,
    { auxiliaryRunners: {} },
  );

  await assert.rejects(
    run,
    (error) => error instanceof PrimaryCollectionTimeoutError && error.timeoutMs === 10,
  );
  assert.equal(observedSignal?.aborted, true);
  assert.equal(observedSignal?.reason instanceof PrimaryCollectionTimeoutError, true);
  await Promise.allSettled(ctx.tasks);
});

test('abortable D1 stops the operation chain after an in-flight statement returns', async () => {
  const controller = new AbortController();
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async first() {
          controller.abort(new Error('collection deadline reached'));
          return { value: 1 };
        },
      };
    },
  };
  const guarded = withAbortableD1(db, controller.signal, 'Stationhead-DB');

  await assert.rejects(
    guarded.prepare('SELECT 1').bind().first(),
    /collection deadline reached/,
  );
});

test('collection abort check preserves the original timeout reason', () => {
  const controller = new AbortController();
  const reason = new PrimaryCollectionTimeoutError(55_000, '* * * * *');
  controller.abort(reason);
  assert.throws(
    () => throwIfCollectionAborted(controller.signal, 'test'),
    (error) => error === reason,
  );
});
