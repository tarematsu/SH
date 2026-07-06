import assert from 'node:assert/strict';
import test from 'node:test';

import { attachBuddyCollectorStatus } from '../functions/lib/buddy-collector-status.js';

test('collector failure at the same timestamp does not invalidate stored playback', () => {
  const payload = attachBuddyCollectorStatus({
    latest_observed_at: 2000,
    playing: true,
    stale: false,
    queue_status: { playing: true, current_index: 0, progress_ms: 10, anchor_at: 2000 },
    queue: [{ is_current: true }],
  }, {
    status: 'error',
    last_attempt_at: 2000,
    last_success_at: 2000,
  });

  assert.equal(payload.stale, false);
  assert.equal(payload.playing, true);
  assert.equal(payload.queue_status.current_index, 0);
  assert.equal(payload.queue[0].is_current, true);
});
