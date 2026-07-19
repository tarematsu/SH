import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeEnrichmentBody,
  shouldLogMinuteEnrichmentResult,
} from '../src/minute-enrichment-optimized-entry.js';

test('identity enrichment strips the single Apple Music field without recursive cloning', () => {
  const body = {
    stage: 'identity',
    minute_at: 960_000,
    queue: {
      tracks: [{ spotify_id: 'sp1', apple_music_id: 'am1', bite_count: 2 }],
    },
  };
  const active = activeEnrichmentBody(body);
  assert.notEqual(active, body);
  assert.deepEqual(active.queue.tracks, [{ spotify_id: 'sp1', bite_count: 2 }]);
  assert.equal(body.queue.tracks[0].apple_music_id, 'am1');
});

test('already clean identity enrichment keeps the original object', () => {
  const body = { stage: 'identity', queue: { tracks: [{ spotify_id: 'sp1' }] } };
  assert.equal(activeEnrichmentBody(body), body);
});

test('success logs are sampled while skips remain visible', () => {
  assert.equal(shouldLogMinuteEnrichmentResult({ minuteAt: 0 }), true);
  assert.equal(shouldLogMinuteEnrichmentResult({ minuteAt: 60_000 }), false);
  assert.equal(shouldLogMinuteEnrichmentResult({ minuteAt: 16 * 60_000 }), true);
  assert.equal(shouldLogMinuteEnrichmentResult({ skipped: true, minuteAt: 60_000 }), true);
});
