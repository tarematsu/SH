import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FACT_QUALITY_FLAGS,
  minuteBucket,
  qualityScore,
  queueStructuralHash,
  reportedStreamCount,
  queueStructurePayload,
  timestampMs,
} from '../src/minute-facts-store.js';

test('minute facts use one stable bucket per minute', () => {
  assert.equal(minuteBucket(125_999), 120_000);
  assert.equal(minuteBucket(120_000), 120_000);
});

test('Stationhead second and millisecond timestamps normalize to milliseconds', () => {
  assert.equal(timestampMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(timestampMs(1_700_000_000_123), 1_700_000_000_123);
});

test('queue structural payload excludes pause and bite changes', () => {
  const payload = queueStructurePayload({
    queue_id: 4,
    start_time: 1_700_000_000,
    is_paused: true,
    tracks: [
      { position: 1, isrc: 'jp-b', duration_ms: 20_000, bite_count: 99 },
      { position: 0, isrc: 'jp-a', duration_ms: 10_000, bite_count: 5 },
    ],
  });
  assert.deepEqual(payload.tracks.map((track) => track.position), [0, 1]);
  assert.equal(Object.hasOwn(payload, 'is_paused'), false);
  assert.equal(Object.hasOwn(payload.tracks[0], 'bite_count'), false);
  assert.equal(payload.start_time, 1_700_000_000_000);
});

test('queue hash remains stable when only pause or bite changes', async () => {
  const first = {
    queue_id: 4,
    start_time: 1_700_000_000,
    is_paused: false,
    tracks: [{ position: 0, isrc: 'JP-A', duration_ms: 10_000, bite_count: 5 }],
  };
  const second = {
    ...first,
    is_paused: true,
    tracks: [{ ...first.tracks[0], bite_count: 8 }],
  };
  assert.equal(await queueStructuralHash(first), await queueStructuralHash(second));
});

test('quality score reflects missing or degraded evidence', () => {
  const flags = FACT_QUALITY_FLAGS.QUEUE_MISSING
    | FACT_QUALITY_FLAGS.TRACK_UNKNOWN
    | FACT_QUALITY_FLAGS.COMMENTS_DEGRADED;
  assert.equal(qualityScore(flags), 0.4);
  assert.equal(qualityScore(0), 1);
});

test('legacy stream rejection quality remains readable during cleanup', () => {
  assert.equal(FACT_QUALITY_FLAGS.STREAM_REJECTED, 64);
  assert.equal(qualityScore(FACT_QUALITY_FLAGS.STREAM_REJECTED), 0.9);
});

test('reported stream count preserves Stationhead values without continuity validation', () => {
  assert.equal(reportedStreamCount(1_234_567), 1_234_567);
  assert.equal(reportedStreamCount('456'), 456);
  assert.equal(reportedStreamCount(456.9), 456);
  assert.equal(reportedStreamCount(null), null);
  assert.equal(reportedStreamCount(-1), null);
  assert.equal(reportedStreamCount('not-a-number'), null);
});
