import assert from 'node:assert/strict';
import test from 'node:test';

import { secondaryPlaybackPayload } from '../functions/api/playback.js';

function row(overrides = {}) {
  return {
    channel_alias: 'buddy46',
    station_id: 46,
    queue_id: 99,
    start_time: 1_200_000,
    is_paused: 0,
    is_broadcasting: 1,
    host_account_id: 9,
    host_handle: 'host46',
    state_hash: 'hash',
    checked_at: 1_250_000,
    changed_at: 1_200_000,
    queue_json: JSON.stringify([{
      position: 0,
      spotify_id: 'sp1',
      duration_ms: 2_000_000,
      title: 'Long Song',
      artist: 'Artist',
    }]),
    ...overrides,
  };
}

test('fresh secondary playback still reports the current track', () => {
  const payload = secondaryPlaybackPayload(row(), 1_300_000);
  assert.equal(payload.stale, false);
  assert.equal(payload.playing, true);
  assert.equal(payload.queue_status.current_index, 0);
  assert.equal(payload.queue[0].is_current, true);
});

test('stale secondary playback cannot appear as currently playing', () => {
  const payload = secondaryPlaybackPayload(row({ checked_at: 300_000 }), 1_300_001);
  assert.equal(payload.stale, true);
  assert.equal(payload.playing, false);
  assert.equal(payload.queue_status.playing, false);
  assert.equal(payload.queue_status.current_index, -1);
  assert.equal(payload.queue_status.progress_ms, 0);
  assert.equal(payload.queue[0].is_current, undefined);
});
