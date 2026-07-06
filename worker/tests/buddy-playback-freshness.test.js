import assert from 'node:assert/strict';
import test from 'node:test';

import { scheduleBuddyPlayback } from '../src/cadenced-entry.js';

test('buddy playback uses the cron slot for cadence and wall clock for observed_at', async () => {
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
