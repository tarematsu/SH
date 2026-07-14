import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetBuddyPlaybackFlightForTests,
  scheduleBuddyPlayback,
} from '../src/cadenced-entry.js';
import { resetBuddyHealthForTests } from '../src/buddy-health.js';

function requestContext() {
  return { waitUntil() {} };
}

test('buddy playback uses the cron slot for cadence and wall clock for observed_at', async () => {
  resetBuddyPlaybackFlightForTests();
  let pending = null;
  let receivedAt = null;
  const task = scheduleBuddyPlayback(
    { BUDDY_PLAYBACK_INTERVAL_MS: '300000' },
    { waitUntil(value) { pending = value; } },
    300_000,
    async (_env, observedAt) => {
      receivedAt = observedAt;
      return { skipped: false, checked_at: observedAt };
    },
    () => 360_000,
  );

  assert.equal(task, pending);
  assert.deepEqual(await task, { skipped: false, checked_at: 360_000 });
  assert.equal(receivedAt, 360_000);
});

test('buddy playback does not run outside the scheduled five-minute bucket', async () => {
  resetBuddyPlaybackFlightForTests();
  let called = false;
  const result = await scheduleBuddyPlayback(
    { BUDDY_PLAYBACK_INTERVAL_MS: '300000' },
    null,
    240_000,
    async () => {
      called = true;
      return { skipped: false };
    },
    () => 360_000,
  );

  assert.deepEqual(result, { skipped: true, reason: 'not-due' });
  assert.equal(called, false);
});

test('overlapping buddy playback calls in one request share one in-flight collection', async () => {
  resetBuddyPlaybackFlightForTests();
  let calls = 0;
  let release;
  const runner = async () => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  };
  const ctx = requestContext();
  const first = scheduleBuddyPlayback({}, ctx, 300_000, runner, () => 360_000);
  const second = scheduleBuddyPlayback({}, ctx, 300_000, runner, () => 361_000);

  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ skipped: false });
  assert.deepEqual(await first, { skipped: false });
  resetBuddyPlaybackFlightForTests();
});

test('different request contexts never share buddy playback I/O', async () => {
  resetBuddyPlaybackFlightForTests();
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { skipped: false, call: calls };
  };

  const first = scheduleBuddyPlayback({}, requestContext(), 300_000, runner, () => 360_000);
  const second = scheduleBuddyPlayback({}, requestContext(), 300_000, runner, () => 361_000);

  assert.notEqual(first, second);
  assert.deepEqual(await Promise.all([first, second]), [
    { skipped: false, call: 1 },
    { skipped: false, call: 2 },
  ]);
  resetBuddyPlaybackFlightForTests();
});

test('a due buddy playback setup skip is recorded as a failure, not a success', async () => {
  resetBuddyPlaybackFlightForTests();
  resetBuddyHealthForTests();
  const writes = [];
  const env = {
    OTHER_DB: {
      prepare(sql) {
        let values = [];
        return {
          bind(...bound) { values = bound; return this; },
          async first() { return null; },
          async run() {
            if (sql.includes('INSERT INTO sh_collector_status')) writes.push(values);
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };

  const result = await scheduleBuddyPlayback(
    env,
    requestContext(),
    300_000,
    async () => ({ skipped: true, reason: 'playback-table-setup-required' }),
    () => 360_000,
  );

  assert.deepEqual(result, { skipped: true, reason: 'playback-table-setup-required' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], 'error');
  assert.equal(writes[0][3], null);
  assert.match(writes[0][4], /playback-table-setup-required/);
});
