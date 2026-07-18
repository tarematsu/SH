import assert from 'node:assert/strict';
import test from 'node:test';

import { processMinuteEnrichment } from '../src/minute-enrichment-entry.js';

function enrichmentBody(observedAt, tracks) {
  return {
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
    host_account_id: 50,
    host_handle: 'host',
    broadcast_start_time: observedAt - 600_000,
    is_broadcasting: 1,
    queue: {
      station_id: 20,
      queue_id: 40,
      start_time: observedAt - 60_000,
      total_track_count: tracks.length,
      materialized_track_count: tracks.length,
      source_structural_hash: 'structure',
      source_likes_hash: 'likes',
      tracks,
    },
  };
}

async function runPlayback(body, playback) {
  let sent = null;
  const result = await processMinuteEnrichment({
    MINUTE_DB: {},
    BUDDIES_DB: {},
    MINUTE_ENRICHMENT_QUEUE: {
      async send(value, options) {
        sent = { value, options };
      },
    },
  }, body, {
    loadCurrentMinute: async () => ({ id: 1, observed_at: body.observed_at, quality_flags: 0 }),
    updatePlaybackState: async () => playback,
    patchPlaybackResult: async () => ({
      position: playback.current_position,
      trackId: playback.current_track_id,
    }),
    requestQueueExpansion: async () => null,
  });
  return { result, sent };
}

test('playback handoff carries only the current bite track into identity enrichment', async () => {
  const observedAt = 1_784_000_000_000;
  const tracks = Array.from({ length: 40 }, (_value, position) => ({
    position,
    queue_track_id: 1_000 + position,
    stationhead_track_id: 2_000 + position,
    spotify_id: `spotify-${position}`,
    apple_music_id: `apple-${position}`,
    isrc: `ISRC${position}`,
    bite_count: 3_000 + position,
    title: `Song ${position}`,
    artist: `Artist ${position}`,
  }));
  const body = enrichmentBody(observedAt, tracks);
  const { result, sent } = await runPlayback(body, {
    current_position: 27,
    current_track_id: 9_027,
    current_schedule_valid: 1,
    delayed: false,
  });

  assert.equal(result.pending, true);
  assert.equal(sent.options.contentType, 'json');
  assert.equal(sent.value.stage, 'identity');
  assert.equal(sent.value.queue_position, 27);
  assert.equal(sent.value.track_id, 9_027);
  assert.equal(sent.value.queue.queue_id, body.queue.queue_id);
  assert.equal(sent.value.queue.start_time, body.queue.start_time);
  assert.equal(sent.value.queue.total_track_count, 40);
  assert.equal(sent.value.queue.materialized_track_count, 40);
  assert.deepEqual(sent.value.queue.tracks, [{
    position: 27,
    queue_track_id: 1_027,
    stationhead_track_id: 2_027,
    spotify_id: 'spotify-27',
    apple_music_id: 'apple-27',
    isrc: 'ISRC27',
    bite_count: 3_027,
  }]);
  assert.equal(Object.hasOwn(sent.value.queue.tracks[0], 'title'), false);
  assert.equal(body.queue.tracks.length, 40);
});

test('playback handoff drops the queue when no bite position was resolved', async () => {
  const observedAt = 1_784_000_060_000;
  const body = enrichmentBody(observedAt, [{ position: 0, bite_count: 4 }]);
  const { sent } = await runPlayback(body, {
    current_position: null,
    current_track_id: null,
    current_schedule_valid: 0,
    delayed: true,
  });

  assert.equal(sent.value.stage, 'identity');
  assert.equal(sent.value.queue_position, null);
  assert.equal(sent.value.queue, null);
});
