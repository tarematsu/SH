import assert from 'node:assert/strict';
import test from 'node:test';

import {
  scheduleBuddyPlayback,
  scheduledTimestamp,
  shouldDeferBuddyPlayback,
} from '../src/cadenced-entry.js';

test('scheduled timestamp uses the cron slot instead of delayed wall-clock time', () => {
  assert.equal(scheduledTimestamp({ scheduledTime: 300_000 }, 360_000), 300_000);
  assert.equal(scheduledTimestamp({}, 360_000), 360_000);
});

test('buddy playback uses wall-clock observation time and is attached to waitUntil', async () => {
  let receivedAt = null;
  let pending = null;
  const result = scheduleBuddyPlayback(
    { DB: {} },
    { waitUntil(value) { pending = value; } },
    300_000,
    async (_env, now) => {
      receivedAt = now;
      return { skipped: false };
    },
    () => 360_000,
  );

  assert.equal(result, pending);
  assert.deepEqual(await result, { skipped: false });
  assert.equal(receivedAt, 360_000);
});

test('production wrapper flag defers cadenced buddy playback', () => {
  assert.equal(shouldDeferBuddyPlayback({}), false);
  assert.equal(shouldDeferBuddyPlayback({ __DEFER_BUDDY_PLAYBACK: true }), true);
});
