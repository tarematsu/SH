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

test('concurrent scheduled calls share the active primary collection before watchdog timeout', async () => {
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

  const first = runPrimaryScheduled(controller, {}, ctx, scheduled, 50);
  const second = runPrimaryScheduled(controller, {}, ctx, scheduled, 50);

  assert.equal(calls, 1);
  active.resolve({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
  await Promise.allSettled(waits);
  resetPrimaryScheduledFlightForTests();
});

test('watchdog timeout abandons the stale primary flight so the next cron can recover', async () => {
  resetPrimaryScheduledFlightForTests();
  const active = [deferred(), deferred()];
  const waits = [];
  let calls = 0;
  const scheduled = () => active[calls++].promise;
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
  assert.equal(calls, 2);

  active[0].resolve({ ok: true });
  active[1].resolve({ ok: true });
  await Promise.allSettled(waits);
  resetPrimaryScheduledFlightForTests();
});
