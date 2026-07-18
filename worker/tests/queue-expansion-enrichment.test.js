import assert from 'node:assert/strict';
import test from 'node:test';

import { processMinuteEnrichment } from '../src/minute-enrichment-entry.js';

test('playback beyond partial coverage requests the next chunk even without a resolved position', async () => {
  let requestedPosition = null;
  const observedAt = 1_784_000_000_000;
  const result = await processMinuteEnrichment({ MINUTE_DB: {}, BUDDIES_DB: {} }, {
    message_type: 'minute-fact-enrichment',
    message_version: 1,
    stage: 'playback',
    channel_id: 10,
    station_id: 20,
    minute_at: observedAt,
    observed_at: observedAt,
    provisional_session_id: 25,
    revision_id: 30,
    queue_start_time: observedAt - 60_000,
    is_paused: false,
    queue: {
      station_id: 20,
      queue_id: 40,
      start_time: observedAt - 60_000,
      total_track_count: 80,
      materialized_track_count: 22,
      source_structural_hash: 'full-queue-generation',
      tracks: Array.from({ length: 22 }, (_value, position) => ({ position })),
    },
  }, {
    loadCurrentMinute: async () => ({ id: 1, observed_at: observedAt, quality_flags: 0 }),
    updatePlaybackState: async () => ({
      current_position: null,
      current_track_id: null,
      current_schedule_valid: 0,
      delayed: true,
    }),
    patchPlaybackResult: async () => ({ position: null, trackId: null }),
    requestQueueExpansion: async (_db, _queue, position) => {
      requestedPosition = position;
      return 32;
    },
    enqueueIdentityStage: async () => {},
  });

  assert.equal(requestedPosition, 21);
  assert.equal(result.requested_materialized_tracks, 32);
});
