import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { onRequestOptions as playbackOptions } from '../functions/api/playback.js';
import { secondaryPlaybackPayload } from '../functions/lib/secondary-playback.js';

const migration = readFileSync(
  new URL('../../database/other-migrations/011_buddy_playback_canonical.sql', import.meta.url),
  'utf8',
);

function playbackRow(overrides = {}) {
  return {
    channel_alias: 'buddy46',
    station_id: 46,
    queue_id: 99,
    start_time: 300_000,
    is_paused: 0,
    is_broadcasting: 1,
    host_account_id: 9,
    host_handle: 'host46',
    state_hash: 'hash',
    checked_at: 340_000,
    changed_at: 300_000,
    paused_total_ms: 0,
    pause_started_at: null,
    queue_json: JSON.stringify([
      {
        position: 0,
        spotify_id: 'sp1',
        isrc: 'JPX1',
        duration_ms: 180_000,
        title: 'Song 1',
        artist: 'Artist',
        thumbnail_url: 'cover-1',
      },
      {
        position: 1,
        spotify_id: 'sp2',
        isrc: 'JPX2',
        duration_ms: 200_000,
        title: 'Song 2',
        artist: 'Artist',
        thumbnail_url: 'cover-2',
      },
    ]),
    ...overrides,
  };
}

test('secondary collector storage remains isolated in OTHER_DB', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sh_buddy_playback_clock/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sh_buddy_track_metadata/);
  assert.doesNotMatch(migration, /MINUTE_DB|BUDDIES_DB/);
});

test('secondary diagnostics compute progress without exposing provider IDs', () => {
  const payload = secondaryPlaybackPayload(playbackRow(), 350_000);
  assert.equal(payload.playing, true);
  assert.equal(payload.queue_status.current_index, 0);
  assert.equal(payload.queue_status.progress_ms, 50_000);
  assert.equal(payload.queue[0].is_current, true);
  assert.equal(payload.queue[1].thumbnail_url, 'cover-2');
  assert.equal('spotify_id' in payload.queue[0], false);
});

test('secondary diagnostics retain stable metadata keys when values are missing', () => {
  const payload = secondaryPlaybackPayload(playbackRow({
    queue_json: JSON.stringify([{ position: 0, spotify_id: 'sp1', duration_ms: 180_000 }]),
  }), 350_000);
  assert.equal(payload.queue[0].title, null);
  assert.equal(payload.queue[0].artist, null);
  assert.equal(payload.queue[0].thumbnail_url, null);
});

test('secondary diagnostics account for completed and active pauses', () => {
  const resumed = secondaryPlaybackPayload(playbackRow({
    paused_total_ms: 120_000,
    checked_at: 499_000,
  }), 500_000);
  assert.equal(resumed.queue_status.progress_ms, 80_000);

  const paused = secondaryPlaybackPayload(playbackRow({
    is_paused: 1,
    changed_at: 330_000,
    pause_started_at: 330_000,
  }), 900_000);
  assert.equal(paused.playing, false);
  assert.equal(paused.queue_status.progress_ms, 30_000);
});

test('secondary diagnostics do not mark a track current after the queue ends', () => {
  const payload = secondaryPlaybackPayload(playbackRow({
    queue_json: JSON.stringify([{ position: 0, duration_ms: 10_000, title: 'Short Song' }]),
  }), 400_000);
  assert.equal(payload.playing, false);
  assert.equal(payload.queue_status.ended, true);
  assert.equal(payload.queue_status.current_index, -1);
  assert.equal('is_current' in payload.queue[0], false);
});

test('secondary diagnostics return safe stale envelopes for corrupt or absent state', () => {
  const corrupt = secondaryPlaybackPayload(playbackRow({ queue_json: '{broken' }), 350_000);
  assert.equal(corrupt.queue_corrupt, true);
  assert.deepEqual(corrupt.queue, []);

  const absent = secondaryPlaybackPayload(null, 350_000);
  assert.equal(absent.stale, true);
  assert.deepEqual(absent.queue, []);
});

test('playback endpoint answers CORS preflight without credentials', () => {
  const response = playbackOptions();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
});
