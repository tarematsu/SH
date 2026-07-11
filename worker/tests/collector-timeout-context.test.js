import assert from 'node:assert/strict';
import test from 'node:test';

import { runCollection } from '../src/collector-runner.js';
import {
  PrimaryCollectionTimeoutError,
  runPrimaryScheduled,
} from '../src/main-scheduler.js';
import { combinedAbortSignal } from '../src/request-signal.js';

function context() {
  const tasks = [];
  return {
    tasks,
    waitUntil(task) { tasks.push(Promise.resolve(task)); },
  };
}

test('concurrent cron invocations do not reuse a promise from another request context', async () => {
  const resolvers = [];
  let calls = 0;
  const scheduled = () => {
    calls += 1;
    return new Promise((resolve) => resolvers.push(resolve));
  };
  const firstContext = context();
  const secondContext = context();
  const first = runPrimaryScheduled(
    { cron: '* * * * *' }, {}, firstContext, scheduled, 1_000, { auxiliaryRunners: {} },
  );
  const second = runPrimaryScheduled(
    { cron: '* * * * *' }, {}, secondContext, scheduled, 1_000, { auxiliaryRunners: {} },
  );
  await Promise.resolve();
  assert.equal(calls, 2);
  resolvers[0]({ run: 1 });
  resolvers[1]({ run: 2 });
  assert.deepEqual(await Promise.all([first, second]), [{ run: 1 }, { run: 2 }]);
  await Promise.all([...firstContext.tasks, ...secondContext.tasks]);
});

test('timeout resets only the request-local collector and reports a timeout', async () => {
  let resets = 0;
  await assert.rejects(
    runPrimaryScheduled(
      { cron: '* * * * *' },
      {},
      context(),
      () => new Promise(() => {}),
      10,
      { auxiliaryRunners: {}, resetCollectionFlight: () => { resets += 1; } },
    ),
    (error) => error instanceof PrimaryCollectionTimeoutError && error.timeoutMs === 10,
  );
  assert.equal(resets, 1);
});

test('collector calls are never deduplicated through a module-level promise', async () => {
  const resolvers = [];
  let calls = 0;
  const collector = () => {
    calls += 1;
    return new Promise((resolve) => resolvers.push(resolve));
  };
  const first = runCollection({}, 'first', collector);
  const second = runCollection({}, 'second', collector);
  await Promise.resolve();
  assert.equal(calls, 2);
  resolvers[0]('first');
  resolvers[1]('second');
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
});

test('chat fallback preserves the caller abort signal', async () => {
  const controller = new AbortController();
  const signal = combinedAbortSignal(controller.signal, 1_000);
  assert.equal(signal.aborted, false);
  controller.abort(new Error('caller timeout'));
  assert.equal(signal.aborted, true);
});

test('chat fallback still has its own timeout without a caller signal', async () => {
  const signal = combinedAbortSignal(null, 5);
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(signal.aborted, true);
});
