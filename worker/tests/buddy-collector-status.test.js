import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachBuddyCollectorStatus,
  buddyCollectorStatus,
  loadBuddyCollectorStatus,
} from '../../site/functions/lib/buddy-collector-status.js';

function playbackPayload() {
  return {
    latest_observed_at: 2_000,
    playing: true,
    stale: false,
    queue_status: {
      playing: true,
      current_index: 0,
      progress_ms: 12_000,
      anchor_at: 1_000,
    },
    queue: [{ spotify_id: 'track-1', is_current: true }],
  };
}

test('unknown collector status suppresses potentially stale playback', () => {
  const collector = buddyCollectorStatus({
    status: 'invalid',
    last_attempt_at: 2_100,
  });
  const result = attachBuddyCollectorStatus(playbackPayload(), collector);

  assert.equal(collector.status, 'unknown');
  assert.equal(result.stale, true);
  assert.equal(result.playing, false);
  assert.equal(result.queue_status.playing, false);
  assert.equal(result.queue_status.current_index, -1);
  assert.equal(result.queue[0].is_current, false);
});

test('missing collector history suppresses old playback until the first success', () => {
  const collector = buddyCollectorStatus(null);
  const result = attachBuddyCollectorStatus(playbackPayload(), collector);

  assert.equal(collector.status, 'never');
  assert.equal(result.stale, true);
  assert.equal(result.playing, false);
});

test('missing collector status schema is reported as unavailable', async () => {
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async first() { throw new Error('no such table: sh_collector_status'); },
      };
    },
  };

  const collector = await loadBuddyCollectorStatus(db, 'buddy46');
  const result = attachBuddyCollectorStatus(playbackPayload(), collector);

  assert.equal(collector.status, 'unknown');
  assert.equal(collector.failure_code, 'COLLECTOR_STATUS_SCHEMA_MISSING');
  assert.equal(result.stale, true);
  assert.equal(result.playing, false);
});

test('healthy collector status preserves current playback', () => {
  const collector = buddyCollectorStatus({
    status: 'ok',
    last_attempt_at: 2_100,
    last_success_at: 2_100,
    tracks: 1,
  });
  const result = attachBuddyCollectorStatus(playbackPayload(), collector);

  assert.equal(result.stale, false);
  assert.equal(result.playing, true);
  assert.equal(result.queue_status.current_index, 0);
  assert.equal(result.queue[0].is_current, true);
});
