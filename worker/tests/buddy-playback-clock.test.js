import assert from 'node:assert/strict';
import test from 'node:test';

import { buddyPlaybackClock } from '../src/buddy-playback.js';

test('buddy playback clock resets when the current queue has no identity', () => {
  const clock = buddyPlaybackClock({
    queue_id: null,
    start_time: null,
    is_paused: 1,
    clock_queue_id: null,
    clock_start_time: null,
    clock_is_paused: 1,
    paused_total_ms: 120_000,
    pause_started_at: 400_000,
  }, {
    queue_id: null,
    start_time: null,
    is_paused: false,
  }, 600_000);

  assert.deepEqual(clock, {
    queue_id: null,
    start_time: null,
    is_paused: 0,
    paused_total_ms: 0,
    pause_started_at: null,
    observed_at: 600_000,
  });
});
