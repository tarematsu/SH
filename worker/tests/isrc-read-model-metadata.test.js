import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachReadModelTrackMetadata,
  saveMinuteFactReadModels,
} from '../src/minute-facts-read-model.js';

test('read-model metadata prefers ISRC over a mismatched Spotify row', () => {
  const queue = {
    tracks: [{ spotify_id: 'new-sp', isrc: ' jpx123 ', title: null, artist: null, thumbnail_url: null }],
  };
  const hydrated = attachReadModelTrackMetadata(queue, [
    { spotify_id: 'new-sp', isrc: 'OTHER', title: 'Wrong', artist: 'Wrong', thumbnail_url: 'wrong' },
    { spotify_id: 'old-sp', isrc: 'JPX123', title: 'Song', artist: 'Artist', thumbnail_url: 'cover' },
  ]);

  assert.equal(hydrated.tracks[0].title, 'Song');
  assert.equal(hydrated.tracks[0].artist, 'Artist');
  assert.equal(hydrated.tracks[0].thumbnail_url, 'cover');
});

test('read-model metadata keeps Spotify fallback for tracks without ISRC', () => {
  const queue = { tracks: [{ spotify_id: 'sp1', title: null, artist: null }] };
  const hydrated = attachReadModelTrackMetadata(queue, [
    { spotify_id: 'sp1', isrc: null, title: 'Song', artist: 'Artist' },
  ]);
  assert.equal(hydrated.tracks[0].title, 'Song');
});

test('minute read-model hydration queries both ISRC and Spotify IDs once', async () => {
  let metadataSql = '';
  let metadataBindings = [];
  const BUDDIES_DB = {
    prepare(sql) {
      metadataSql = sql;
      return {
        bind(...values) { metadataBindings = values; return this; },
        async all() {
          return {
            results: [{
              spotify_id: 'old-sp',
              isrc: 'JPX123',
              title: 'Song',
              artist: 'Artist',
              thumbnail_url: 'cover',
              fetched_at: 10,
            }],
          };
        },
      };
    },
  };
  const batches = [];
  const MINUTE_DB = {
    prepare(sql) {
      return {
        sql,
        params: [],
        bind(...params) { this.params = params; return this; },
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };

  await saveMinuteFactReadModels({ BUDDIES_DB, MINUTE_DB }, {
    channel: { channel_id: 10, observed_at: 123_456, presentation: {} },
    queue: {
      station_id: 5,
      queue_id: 9,
      start_time: 100,
      is_paused: false,
      value: {
        tracks: [{
          spotify_id: 'new-sp',
          isrc: 'jpx123',
          title: null,
          artist: null,
          thumbnail_url: null,
        }],
      },
    },
    collector: { collector_id: 'cloudflare-worker', updated_at: 123_456 },
  }, 'minute-fact:10:120000');

  assert.match(metadataSql, /isrc IN \(\?\)/);
  assert.match(metadataSql, /spotify_id IN \(\?\)/);
  assert.deepEqual(metadataBindings, ['JPX123', 'new-sp']);
  assert.match(batches[0][1].params[6], /"title":"Song"/);
  assert.match(batches[0][1].params[6], /"thumbnail_url":"cover"/);
});
