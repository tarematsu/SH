import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computePlayback } from '../site/functions/lib/playback.js';
import {
  buildPrimaryPlaybackRows,
  computePrimaryPlayback,
} from '../site/functions/lib/primary-playback.js';

test('computePlayback returns current track progress and anchors', () => {
  const queue = [
    { start_time: 1_000, duration_ms: 10_000 },
    { start_time: 1_000, duration_ms: 20_000 },
  ];

  const playback = computePlayback(queue, 16_000);

  assert.equal(playback.currentIndex, 1);
  assert.equal(playback.progressMs, 5_000);
  assert.equal(playback.anchorAt, 11_000);
  assert.equal(playback.queueEndAt, 31_000);
});

test('computePlayback clamps to the last track when elapsed exceeds queue duration', () => {
  const queue = [
    { start_time: 1_000, duration_ms: 10_000 },
    { start_time: 1_000, duration_ms: 20_000 },
  ];

  const playback = computePlayback(queue, 40_000);

  assert.equal(playback.currentIndex, 1);
  assert.equal(playback.progressMs, 20_000);
  assert.equal(playback.anchorAt, 11_000);
  assert.equal(playback.queueEndAt, 31_000);
});

test('canonical playback subtracts completed pauses before choosing the current track', () => {
  const rows = [
    { playback_offset_ms: 0, duration_ms: 180_000 },
    { playback_offset_ms: 180_000, duration_ms: 180_000 },
  ];
  const playback = computePrimaryPlayback(rows, {
    queue_start_time: 1_000,
    paused_total_ms: 120_000,
    is_paused: 0,
  }, 241_000);

  assert.equal(playback.currentIndex, 0);
  assert.equal(playback.progressMs, 120_000);
  assert.equal(playback.anchorAt, 121_000);
  assert.equal(playback.ended, false);
});

test('primary playback merges live queue, canonical track, and metadata fields', () => {
  const queueRow = {
    queue_id: 9,
    start_time: 1_000,
    observed_at: 2_000,
    queue_json: JSON.stringify({
      tracks: [{
        position: 0,
        spotify_id: 'sp1',
        isrc: 'JPX1',
        title: 'Live Title',
        thumbnail_url: 'https://img.example/live.jpg',
      }],
    }),
  };
  const rows = buildPrimaryPlaybackRows([{
    position: 0,
    spotify_id: 'sp1',
    isrc: 'JPX1',
    duration_ms: 180_000,
    playback_offset_ms: 0,
    schedule_valid: 1,
    canonical_title: 'Canonical Title',
    canonical_artist: 'Canonical Artist',
  }], queueRow, {
    queue_id: 9,
    queue_start_time: 1_000,
    last_observed_at: 2_000,
  }, [{
    spotify_id: 'sp1',
    isrc: 'JPX1',
    title: 'Metadata Title',
    artist: 'Metadata Artist',
    thumbnail_url: 'https://img.example/metadata.jpg',
    fetched_at: 3_000,
  }]);

  assert.equal(rows[0].title, 'Live Title');
  assert.equal(rows[0].artist, 'Metadata Artist');
  assert.equal(rows[0].thumbnail_url, 'https://img.example/live.jpg');
  assert.equal(rows[0].duration_ms, 180_000);
});
