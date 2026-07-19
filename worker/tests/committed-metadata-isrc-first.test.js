import assert from 'node:assert/strict';
import test from 'node:test';

import { runCommittedMetadataEnrichment } from '../src/committed-metadata-enrichment.js';

function minuteDb(resultSets) {
  let reads = 0;
  return {
    get reads() { return reads; },
    prepare(sql) {
      assert.match(sql, /FROM sh_track_dictionary/);
      return {
        bind() {
          return {
            async all() {
              const results = resultSets[Math.min(reads, resultSets.length - 1)] || [];
              reads += 1;
              return { results };
            },
          };
        },
      };
    },
  };
}

function job(tracks) {
  return [{
    jobId: 'metadata:test',
    payload: {
      observedAt: 123_456,
      queue: { station_id: 1, tracks },
    },
  }];
}

test('complete ISRC dictionary rows skip both external metadata providers', async () => {
  const DB = minuteDb([[{
    isrc: 'JPABC1234567',
    title: 'Song',
    artist: 'Artist',
    thumbnail_url: 'cover',
  }]]);
  let isrcCalls = 0;
  let spotifyCalls = 0;

  await runCommittedMetadataEnrichment({ MINUTE_DB: DB }, job([{
    isrc: 'JPABC1234567',
    spotify_id: 'spotify-id',
  }]), {
    config: {},
    enrichIsrcTracks: async () => { isrcCalls += 1; },
    enrichSpotifyTracks: async () => { spotifyCalls += 1; },
    ingest: async () => {},
  });

  assert.equal(isrcCalls, 0);
  assert.equal(spotifyCalls, 0);
  assert.equal(DB.reads, 2);
});

test('ISRC title repair runs before Spotify artwork fallback', async () => {
  const DB = minuteDb([
    [{ isrc: 'JPABC1234567', title: null, artist: null, thumbnail_url: null }],
    [{ isrc: 'JPABC1234567', title: 'Song', artist: 'Artist', thumbnail_url: null }],
  ]);
  const order = [];
  let isrcTracks = [];
  let spotifyTracks = [];

  await runCommittedMetadataEnrichment({ MINUTE_DB: DB }, job([{
    isrc: 'JPABC1234567',
    spotify_id: 'spotify-id',
  }]), {
    config: {},
    enrichIsrcTracks: async (_env, queue) => {
      order.push('isrc');
      isrcTracks = queue.tracks;
      return { attempted: 1, saved: 1 };
    },
    enrichSpotifyTracks: async (_env, _ingest, queue) => {
      order.push('spotify');
      spotifyTracks = queue.tracks;
      return 1;
    },
    ingest: async () => {},
  });

  assert.deepEqual(order, ['isrc', 'spotify']);
  assert.equal(isrcTracks.length, 1);
  assert.equal(spotifyTracks.length, 1);
});

test('tracks without ISRC retain Spotify as the compatibility fallback', async () => {
  const DB = minuteDb([[]]);
  let spotifyTracks = [];

  await runCommittedMetadataEnrichment({ MINUTE_DB: DB }, job([{
    isrc: null,
    spotify_id: 'spotify-only',
  }]), {
    config: {},
    enrichIsrcTracks: async () => {
      assert.fail('ISRC enrichment must not receive provider-only tracks');
    },
    enrichSpotifyTracks: async (_env, _ingest, queue) => {
      spotifyTracks = queue.tracks;
      return 1;
    },
    ingest: async () => {},
  });

  assert.equal(spotifyTracks.length, 1);
  assert.equal(spotifyTracks[0].spotify_id, 'spotify-only');
});
