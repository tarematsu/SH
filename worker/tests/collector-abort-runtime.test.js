import assert from 'node:assert/strict';
import test from 'node:test';

import {
  throwIfCollectionAborted,
  withAbortableD1,
} from '../src/collector-runner.js';
import {
  PrimaryCollectionTimeoutError,
  runPrimaryScheduled,
} from '../src/main-scheduler.js';

function context() {
  const tasks = [];
  return {
    tasks,
    waitUntil(task) { tasks.push(Promise.resolve(task)); },
  };
}

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
