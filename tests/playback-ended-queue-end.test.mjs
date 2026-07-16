import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computePrimaryPlayback } from '../site/functions/lib/primary-playback.js';

test('ended primary playback keeps the scheduled queue end instead of generation time', () => {
  const playback = computePrimaryPlayback([
    { playback_offset_ms: 0, duration_ms: 10_000 },
    { playback_offset_ms: 10_000, duration_ms: 20_000 },
  ], {
    queue_start_time: 1_000,
    paused_total_ms: 5_000,
    is_paused: 0,
  }, 100_000);

  assert.equal(playback.ended, true);
  assert.equal(playback.queueEndAt, 36_000);
  assert.notEqual(playback.queueEndAt, 100_000);
});
