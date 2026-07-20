import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachBuddyCollectorStatus,
  buddyCollectorStatus,
} from '../functions/lib/buddy-collector-status.js';

test('missing buddy collector heartbeat is reported as never collected', () => {
  const status = buddyCollectorStatus(null);
  assert.equal(status.status, 'never');
  assert.equal(status.last_attempt_at, null);
  assert.equal(status.last_success_at, null);
});

test('unrecognized buddy collector status value is reported as unknown', () => {
  const status = buddyCollectorStatus({ last_attempt_at: 1234, status: 'broken' });
  assert.equal(status.status, 'unknown');
  assert.equal(status.last_attempt_at, 1234);
  assert.equal(status.failure_code, 'COLLECTOR_STATUS_INVALID');
});

test('a failed collection newer than playback data marks the feed stale', () => {
  const payload = attachBuddyCollectorStatus({
    latest_observed_at: 1000,
    playing: true,
    stale: false,
    queue_status: {
      playing: true,
      current_index: 0,
      progress_ms: 500,
      anchor_at: 1000,
    },
    queue: [{ is_current: true }],
  }, {
    status: 'error',
    last_attempt_at: 2000,
    last_success_at: 1000,
  });

  assert.equal(payload.stale, true);
  assert.equal(payload.playing, false);
  assert.equal(payload.queue_status.current_index, -1);
  assert.equal(payload.queue_status.progress_ms, 0);
  assert.equal(payload.queue[0].is_current, false);
});

test('an older collector error does not invalidate newer playback data', () => {
  const payload = attachBuddyCollectorStatus({
    latest_observed_at: 3000,
    playing: true,
    stale: false,
    queue_status: { playing: true, current_index: 0, progress_ms: 500, anchor_at: 3000 },
    queue: [{ is_current: true }],
  }, {
    status: 'error',
    last_attempt_at: 2000,
    last_success_at: 1000,
  });

  assert.equal(payload.stale, false);
  assert.equal(payload.playing, true);
  assert.equal(payload.queue_status.current_index, 0);
});
