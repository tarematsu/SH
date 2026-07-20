import assert from 'node:assert/strict';
import test from 'node:test';

import { compactCollectedQueue } from '../src/collected-track-metadata.js';

const STRUCTURAL = Symbol.for('stationhead.queue.structural-payload');
const LIKES = Symbol.for('stationhead.queue.like-analysis');

test('raw queue compaction reads track identity and likes once', () => {
  const reads = { isrc: 0, spotify: 0, bites: 0 };
  const track = {
    position: 0,
    queue_track_id: 11,
    stationhead_track_id: 22,
    duration_ms: 180_000,
    title: 'Song',
    artist: 'Artist',
    thumbnail_url: 'cover',
    get isrc() { reads.isrc += 1; return 'JP-ABC-12-34567'; },
    get spotify_id() { reads.spotify += 1; return 'spotify-fallback'; },
    get bite_count() { reads.bites += 1; return 4; },
  };
  const queue = {
    station_id: 123,
    queue_id: 456,
    start_time: 789,
    is_paused: false,
    tracks: [track],
  };

  const result = compactCollectedQueue(queue);

  assert.deepEqual(reads, { isrc: 1, spotify: 1, bites: 1 });
  assert.deepEqual(result.queue.tracks[0], {
    position: 0,
    queue_track_id: 11,
    stationhead_track_id: 22,
    spotify_id: null,
    isrc: 'JPABC1234567',
    duration_ms: 180_000,
    bite_count: 4,
  });
  assert.deepEqual(result.queue[STRUCTURAL].tracks[0], {
    position: 0,
    queue_track_id: 11,
    stationhead_track_id: 22,
    spotify_id: null,
    isrc: 'JPABC1234567',
    duration_ms: 180_000,
  });
  assert.deepEqual(result.queue.tracks[LIKES], {
    complete: true,
    payload: [{ track_key: 'isrc:JPABC1234567', like_count: 4 }],
  });
  assert.deepEqual(result.metadata, [{
    isrc: 'JPABC1234567',
    spotify_id: null,
    title: 'Song',
    artist: 'Artist',
    thumbnail_url: 'cover',
  }]);
});
