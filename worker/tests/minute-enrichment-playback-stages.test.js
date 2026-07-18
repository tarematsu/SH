import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLAYBACK_PATCH_STAGE,
  processMinutePlaybackPatch,
  processMinutePlaybackResolve,
} from '../src/minute-enrichment-playback-stages.js';
import {
  processMinuteEnrichmentBatch,
  processOptimizedMinuteEnrichment,
} from '../src/minute-enrichment-optimized-entry.js';

function playbackBody(trackCount = 4) {
  const observedAt = 1_784_000_000_000;
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
      total_track_count: trackCount + 10,
      materialized_track_count: trackCount,
      source_structural_hash: 'structure',
      source_likes_hash: 'likes',
      tracks: Array.from({ length: trackCount }, (_value, position) => ({
        position,
        queue_track_id: 100 + position,
        stationhead_track_id: 200 + position,
        spotify_id: `sp${position}`,
        apple_music_id: `am${position}`,
        isrc: `ISRC${position}`,
        bite_count: 300 + position,
        title: `unused ${position}`,
      })),
    },
  };
}

test('playback resolve updates state and sends a compact playback-patch message', async () => {
  const body = playbackBody(40);
  let sent = null;
  const result = await processMinutePlaybackResolve({ MINUTE_DB: {} }, body, {
    loadCurrentMinute: async () => ({ id: 1, observed_at: body.observed_at, quality_flags: 0 }),
    updatePlaybackState: async () => ({
      current_position: 27,
      current_track_id: 9_027,
      current_schedule_valid: 1,
      delayed: false,
    }),
    sendStage: async (message) => { sent = message; },
  });

  assert.equal(result.stage, 'playback');
  assert.equal(result.playback_patch_deferred, true);
  assert.equal(sent.stage, PLAYBACK_PATCH_STAGE);
  assert.equal(sent.playback.current_position, 27);
  assert.equal(sent.playback.current_track_id, 9_027);
  assert.equal(sent.queue.total_track_count, 50);
  assert.equal(sent.queue.materialized_track_count, 40);
  assert.deepEqual(sent.queue.tracks, [{
    position: 27,
    queue_track_id: 127,
    stationhead_track_id: 227,
    spotify_id: 'sp27',
    apple_music_id: 'am27',
    isrc: 'ISRC27',
    bite_count: 327,
  }]);
  assert.equal(Object.hasOwn(sent.queue.tracks[0], 'title'), false);
  assert.equal(Object.hasOwn(sent, 'queue_start_time'), false);
  assert.equal(Object.hasOwn(sent, 'is_paused'), false);
});

test('playback patch updates the fact, requests expansion, and sends identity', async () => {
  const original = playbackBody(4);
  const body = {
    ...original,
    stage: PLAYBACK_PATCH_STAGE,
    playback: {
      current_position: 3,
      current_track_id: 903,
      current_schedule_valid: 1,
      delayed: false,
    },
    queue: {
      ...original.queue,
      tracks: [original.queue.tracks[3]],
    },
  };
  let expansionPosition = null;
  let sent = null;
  const result = await processMinutePlaybackPatch({ MINUTE_DB: {}, BUDDIES_DB: {} }, body, {
    loadCurrentMinute: async () => ({ id: 1, observed_at: body.observed_at, quality_flags: 0 }),
    patchPlaybackResult: async (_db, _current, _identity, playback) => ({
      position: playback.current_position,
      trackId: playback.current_track_id,
    }),
    requestQueueExpansion: async (_db, _queue, position) => {
      expansionPosition = position;
      return 8;
    },
    sendStage: async (message) => { sent = message; },
  });

  assert.equal(result.stage, PLAYBACK_PATCH_STAGE);
  assert.equal(result.requested_materialized_tracks, 8);
  assert.equal(expansionPosition, 3);
  assert.equal(sent.stage, 'identity');
  assert.equal(sent.queue_position, 3);
  assert.equal(sent.track_id, 903);
  assert.equal(sent.queue.tracks.length, 1);
  assert.equal(sent.queue.tracks[0].position, 3);
  assert.equal(Object.hasOwn(sent, 'playback'), false);
});

test('both playback stages reject a stale minute winner before mutation', async () => {
  const body = playbackBody(1);
  let updates = 0;
  let patches = 0;
  let sends = 0;
  const stale = async () => ({ id: 1, observed_at: body.observed_at + 1, quality_flags: 0 });

  const resolveResult = await processMinutePlaybackResolve({ MINUTE_DB: {} }, body, {
    loadCurrentMinute: stale,
    updatePlaybackState: async () => { updates += 1; },
    sendStage: async () => { sends += 1; },
  });
  const patchResult = await processMinutePlaybackPatch({ MINUTE_DB: {} }, {
    ...body,
    stage: PLAYBACK_PATCH_STAGE,
    playback: {},
  }, {
    loadCurrentMinute: stale,
    patchPlaybackResult: async () => { patches += 1; },
    sendStage: async () => { sends += 1; },
  });

  assert.equal(resolveResult.reason, 'stale-minute-winner');
  assert.equal(patchResult.reason, 'stale-minute-winner');
  assert.equal(updates, 0);
  assert.equal(patches, 0);
  assert.equal(sends, 0);
});

test('optimized router keeps identity on the existing core path', async () => {
  const body = {
    message_type: 'minute-fact-enrichment',
    message_version: 1,
    stage: 'identity',
    channel_id: 10,
    minute_at: 120_000,
    observed_at: 125_000,
  };
  let coreCalls = 0;
  const result = await processOptimizedMinuteEnrichment({}, body, {
    processMinuteEnrichment: async (_env, value) => {
      coreCalls += 1;
      assert.equal(value, body);
      return { stage: 'identity', pending: false };
    },
  });

  assert.equal(coreCalls, 1);
  assert.equal(result.stage, 'identity');
});

test('optimized one-message queue preserves ack and retry semantics', async () => {
  const body = playbackBody(1);
  let acked = 0;
  let retried = 0;
  await processMinuteEnrichmentBatch({
    messages: [{
      body,
      ack() { acked += 1; },
      retry() { retried += 1; },
    }],
  }, {}, {
    processMinutePlaybackResolve: async () => ({
      stage: 'playback',
      pending: true,
      playback_patch_deferred: true,
    }),
  });

  assert.equal(acked, 1);
  assert.equal(retried, 0);
});
