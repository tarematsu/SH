import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PrimaryCollectionTimeoutError,
  resetPrimaryScheduledFlightForTests,
  runPrimaryScheduled,
} from '../src/main.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('watchdog timeout does not start a second primary collection while the first still runs', async () => {
  resetPrimaryScheduledFlightForTests();
  const active = deferred();
  const waits = [];
  let calls = 0;
  const scheduled = () => {
    calls += 1;
    return active.promise;
  };
  const ctx = { waitUntil: (promise) => waits.push(Promise.resolve(promise)) };
  const controller = { cron: '* * * * *' };

  await assert.rejects(
    runPrimaryScheduled(controller, {}, ctx, scheduled, 5),
    (error) => error instanceof PrimaryCollectionTimeoutError,
  );
  await assert.rejects(
    runPrimaryScheduled(controller, {}, ctx, scheduled, 5),
    (error) => error instanceof PrimaryCollectionTimeoutError,
  );
  assert.equal(calls, 1);

  active.resolve({ ok: true });
  await Promise.allSettled(waits);
  resetPrimaryScheduledFlightForTests();
});
