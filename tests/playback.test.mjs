import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computePlayback } from '../site/functions/lib/playback.js';

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
