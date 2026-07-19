import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachCollectedTrackMetadata,
  compactCollectedQueue,
  metadataForCollectedQueue,
  normalizeCollectedIsrc,
  persistCollectedTrackMetadata,
} from '../src/collected-track-metadata.js';

const STRUCTURAL = Symbol.for('stationhead.queue.structural-payload');
const LIKES = Symbol.for('stationhead.queue.like-analysis');

function sourceQueue() {
  const tracks = [{
    position: 0,
    queue_track_id: 11,
    stationhead_track_id: 22,
    spotify_id: 'spotify-complete',
    deezer_id: 'deezer-unused',
    isrc: 'JP-ABC-12-34567',
    duration_ms: 180_000,
    preview_url: 'https://preview.invalid/audio',
    bite_count: 4,
    title: 'Song',
    artist: 'Artist',
    album_name: 'Album',
    thumbnail_url: 'https://image.invalid/cover',
  }, {
    position: 1,
    queue_track_id: 12,
    stationhead_track_id: 23,
    spotify_id: 'spotify-fallback',
    isrc: 'USABC1234567',
    duration_ms: 190_000,
    bite_count: 5,
    title: 'Needs artwork',
    artist: 'Artist',
    thumbnail_url: null,
  }, {
    position: 2,
    spotify_id: 'spotify-only',
    isrc: null,
    bite_count: 6,
    title: 'Legacy',
    artist: 'Legacy Artist',
    thumbnail_url: 'legacy-cover',
  }];
  Object.defineProperty(tracks, LIKES, {
    value: { complete: true, payload: [{ track_key: 'isrc:JP-ABC-12-34567', like_count: 4 }] },
  });
  const queue = {
    station_id: 123,
    queue_id: 456,
    start_time: 789,
    is_paused: false,
    tracks,
  };
  Object.defineProperty(queue, STRUCTURAL, {
    value: { station_id: 123, queue_id: 456, start_time: 789, is_paused: 0, tracks: [] },
  });
  return queue;
}

test('normalizes ISRC and rejects provider IDs masquerading as recordings', () => {
  assert.equal(normalizeCollectedIsrc(' jp-abc-12-34567 '), 'JPABC1234567');
  assert.equal(normalizeCollectedIsrc('spotify-only'), null);
});

test('raw collection queue keeps only operational fields and ISRC-first identity', () => {
  const { queue, metadata } = compactCollectedQueue(sourceQueue());

  assert.deepEqual(queue.tracks[0], {
    position: 0,
    queue_track_id: 11,
    stationhead_track_id: 22,
    spotify_id: null,
    isrc: 'JPABC1234567',
    duration_ms: 180_000,
    bite_count: 4,
  });
  assert.equal(Object.hasOwn(queue.tracks[0], 'title'), false);
  assert.equal(Object.hasOwn(queue.tracks[0], 'preview_url'), false);
  assert.equal(Object.hasOwn(queue.tracks[0], 'deezer_id'), false);
  assert.equal(queue[STRUCTURAL].tracks[0].spotify_id, null);
  assert.equal(queue.tracks[LIKES].complete, true);

  const complete = metadata.find((row) => row.isrc === 'JPABC1234567');
  const incomplete = metadata.find((row) => row.isrc === 'USABC1234567');
  const legacy = metadata.find((row) => row.spotify_id === 'spotify-only');
  assert.equal(complete.spotify_id, null);
  assert.equal(incomplete.spotify_id, 'spotify-fallback');
  assert.equal(legacy.isrc, null);
});

test('materialized metadata is filtered and restored only for visible tracks', () => {
  const { queue, metadata } = compactCollectedQueue(sourceQueue());
  const visibleQueue = { ...queue, tracks: queue.tracks.slice(0, 1) };
  const visibleMetadata = metadataForCollectedQueue(metadata, visibleQueue);
  const hydrated = attachCollectedTrackMetadata(visibleQueue, visibleMetadata);

  assert.equal(visibleMetadata.length, 1);
  assert.equal(hydrated.tracks[0].title, 'Song');
  assert.equal(hydrated.tracks[0].artist, 'Artist');
  assert.equal(hydrated.tracks[0].thumbnail_url, 'https://image.invalid/cover');
  assert.equal(hydrated.tracks[0].spotify_id, null);
});

test('dictionary persistence writes only normalized ISRC metadata', async () => {
  const bound = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          bound.push({ sql, values });
          return { async run() { return { meta: { changes: 1 } }; } };
        },
      };
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const result = await persistCollectedTrackMetadata(db, [{
    isrc: 'jp-abc-12-34567',
    spotify_id: null,
    title: 'Song',
    artist: 'Artist',
    thumbnail_url: 'cover',
  }, {
    isrc: null,
    spotify_id: 'spotify-only',
    title: 'Legacy',
  }], 123_456);

  assert.equal(result.attempted, 1);
  assert.equal(result.changed, 1);
  assert.equal(bound.length, 1);
  assert.equal(bound[0].values[0], 'JPABC1234567');
  assert.match(bound[0].sql, /WHERE \(sh_track_dictionary\.spotify_id IS NULL/);
});
