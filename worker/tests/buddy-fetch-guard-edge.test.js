import assert from 'node:assert/strict';
import test from 'node:test';

import { validateBuddyQueuePayload } from '../src/buddy-fetch-guard.js';

test('payload with neither broadcasting state nor queue is rejected', () => {
  assert.throws(
    () => validateBuddyQueuePayload({ alias: 'buddy46', current_station: {} }),
    /missing broadcasting state and queue/,
  );
});

test('queue track field must contain an array', () => {
  assert.throws(
    () => validateBuddyQueuePayload({
      alias: 'buddy46',
      current_station: {
        is_broadcasting: true,
        queue: { id: 99, queue_tracks: null },
      },
    }),
    /queue tracks are not an array/,
  );
});

test('explicit off-air state may omit a queue', () => {
  const payload = {
    alias: 'buddy46',
    current_station: { is_broadcasting: false },
  };
  assert.equal(validateBuddyQueuePayload(payload), payload);
});
