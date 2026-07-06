import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestGet } from '../functions/api/playback.js';
import {
  attachBuddyCollectorStatus,
  buddyCollectorStatus,
} from '../functions/lib/buddy-collector-status.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

test('missing buddy collector heartbeat is reported as never collected', () => {
  const status = buddyCollectorStatus(null);
  assert.equal(status.status, 'never');
  assert.equal(status.last_attempt_at, null);
  assert.equal(status.last_success_at, null);
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

test('secondary playback endpoint exposes collector failure when no queue row exists', async () => {
  const db = new FakeD1Database()
    .route('first', 'sh_collector_heartbeats', {
      last_seen_at: 2000,
      metadata_json: JSON.stringify({
        status: 'error',
        last_attempt_at: 2000,
        last_success_at: null,
        last_error: 'authentication failed',
        failure_code: 'STATIONHEAD_AUTH_ERROR',
        failure_stage: 'stationhead_auth',
      }),
    })
    .route('first', 'sh_playback_channel_current', null);

  const response = await onRequestGet({
    request: new Request('https://skrzk.test/api/playback?channel=buddy46'),
    env: { DB: db },
  });
  const body = await responseJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.stale, true);
  assert.equal(body.collector.status, 'error');
  assert.equal(body.collector.failure_code, 'STATIONHEAD_AUTH_ERROR');
  assert.equal(body.collector.last_error, 'authentication failed');
  assert.deepEqual(body.queue, []);
});
