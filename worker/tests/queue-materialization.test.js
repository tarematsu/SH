import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseMaterializedTrackCount,
  expansionRequest,
  materializeQueueWindow,
  prepareMaterializedQueue,
  QUEUE_MATERIALIZATION_DEFAULTS,
} from '../src/queue-materialization.js';
import { queueStructuralHash } from '../src/minute-facts-queue-cache.js';

function fullQueue(count = 80) {
  return {
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    is_paused: 0,
    tracks: Array.from({ length: count }, (_value, position) => ({
      position,
      isrc: `JPTEST${String(position).padStart(4, '0')}`,
      spotify_id: `spotify-${position}`,
      duration_ms: 180_000,
      bite_count: position,
    })),
  };
}

function fullAnalysis(queue, hash = 'full-structure-a') {
  return {
    structural: {
      station_id: queue.station_id,
      queue_id: queue.queue_id,
      start_time: queue.start_time,
      is_paused: queue.is_paused,
      tracks: queue.tracks.map((track) => ({
        position: track.position,
        queue_track_id: null,
        stationhead_track_id: null,
        spotify_id: track.spotify_id,
        deezer_id: null,
        isrc: track.isrc,
        duration_ms: track.duration_ms,
        preview_url: null,
      })),
    },
    likes: {
      complete: queue.tracks.every((track) => track.bite_count != null),
      payload: queue.tracks
        .filter((track) => track.bite_count != null)
        .map((track) => ({
          track_key: `isrc:${track.isrc}`,
          like_count: track.bite_count,
        })),
    },
    structural_hash: hash,
    likes_hash: 'full-likes-a',
  };
}

test('closed revision reach defaults materialize the first 22 tracks', () => {
  const queue = fullQueue();
  const analysis = fullAnalysis(queue);
  assert.equal(QUEUE_MATERIALIZATION_DEFAULTS.initial_tracks, 22);
  assert.equal(chooseMaterializedTrackCount(queue, analysis), 22);
});

test('same queue generation honors a larger requested window and new generation resets it', () => {
  const queue = fullQueue();
  const analysis = fullAnalysis(queue);
  const state = {
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    source_structural_hash: analysis.structural_hash,
    requested_count: 32,
  };
  assert.equal(chooseMaterializedTrackCount(queue, analysis, state), 32);
  assert.equal(chooseMaterializedTrackCount(queue, fullAnalysis(queue, 'changed'), state), 22);
});

test('materialized queue retains total count and full source hash while omitting the tail', async () => {
  const queue = fullQueue();
  const analysis = fullAnalysis(queue);
  const materialized = materializeQueueWindow(queue, analysis, 22);

  assert.equal(materialized.queue.tracks.length, 22);
  assert.equal(materialized.queue.total_track_count, 80);
  assert.equal(materialized.queue.materialized_track_count, 22);
  assert.equal(materialized.queue.materialization_complete, false);
  assert.equal(materialized.analysis.structural.tracks.length, 22);
  assert.equal(materialized.analysis.structural.source_structural_hash, 'full-structure-a');
  assert.equal(materialized.analysis.likes.payload.length, 22);
  assert.equal(await queueStructuralHash(materialized.queue), 'full-structure-a');
});

test('omitted-tail like gaps do not make a complete visible window incomplete', async () => {
  const queue = fullQueue();
  queue.tracks[40].bite_count = null;
  const analysis = fullAnalysis(queue);
  assert.equal(analysis.likes.complete, false);

  const materialized = await prepareMaterializedQueue(null, queue, analysis, {
    QUEUE_INITIAL_TRACKS: 22,
  });
  assert.equal(materialized.analysis.likes.complete, true);
  assert.equal(materialized.analysis.likes.payload.length, 22);
  assert.equal(typeof materialized.analysis.likes_hash, 'string');
});

test('producer computes separate persistence hashes for each materialized window', async () => {
  const queue = fullQueue();
  const analysis = fullAnalysis(queue);
  const first = await prepareMaterializedQueue(null, queue, analysis, { QUEUE_INITIAL_TRACKS: 22 });
  const expanded = await prepareMaterializedQueue(null, queue, analysis, { QUEUE_INITIAL_TRACKS: 32 });

  assert.equal(typeof first.analysis.structural_hash, 'string');
  assert.equal(typeof first.analysis.likes_hash, 'string');
  assert.notEqual(first.analysis.structural_hash, analysis.structural_hash);
  assert.notEqual(first.analysis.structural_hash, expanded.analysis.structural_hash);
  assert.equal(first.analysis.source_structural_hash, analysis.structural_hash);
  assert.equal(expanded.analysis.source_structural_hash, analysis.structural_hash);
});

test('expansion requests ten more tracks only at the five-track low-water mark', () => {
  const materialized = {
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    total_track_count: 80,
    materialized_track_count: 22,
    source_structural_hash: 'full-structure-a',
    tracks: fullQueue().tracks.slice(0, 22),
  };
  assert.equal(expansionRequest(materialized, 15), null);
  assert.equal(expansionRequest(materialized, 16), 32);
  assert.equal(expansionRequest({ ...materialized, materialized_track_count: 80 }, 74), null);
});
