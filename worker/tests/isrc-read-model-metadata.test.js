import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachReadModelTrackMetadata,
  preserveReadModelTrackMetadata,
  queueNeedsPreviousTrackMetadata,
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

test('same-queue updates preserve complete metadata from the previous minute read model', () => {
  const next = {
    tracks: [{ position: 0, spotify_id: 'sp1', title: null, artist: null, thumbnail_url: null }],
  };
  const previous = {
    tracks: [{ position: 0, spotify_id: 'sp1', title: 'Song', artist: 'Artist', thumbnail_url: 'cover' }],
  };
  const stable = preserveReadModelTrackMetadata(next, previous);
  assert.deepEqual(stable.tracks[0], {
    position: 0,
    spotify_id: 'sp1',
    title: 'Song',
    artist: 'Artist',
    album_name: null,
    thumbnail_url: 'cover',
  });
});

test('previous metadata is not copied to a different track at the same position', () => {
  const next = {
    tracks: [{ position: 0, spotify_id: 'sp2', title: null, artist: null, thumbnail_url: null }],
  };
  const previous = {
    tracks: [{ position: 0, spotify_id: 'sp1', title: 'Old', artist: 'Old', thumbnail_url: 'old' }],
  };
  assert.equal(preserveReadModelTrackMetadata(next, previous), next);
});

test('complete queue metadata skips the previous read-model lookup', async () => {
  let previousReads = 0;
  const batches = [];
  const completeQueue = {
    tracks: [{
      position: 0,
      spotify_id: 'sp1',
      title: 'Song',
      artist: 'Artist',
      album_name: 'Album',
      thumbnail_url: 'cover',
    }],
  };
  assert.equal(queueNeedsPreviousTrackMetadata(completeQueue), false);
  assert.equal(queueNeedsPreviousTrackMetadata({
    tracks: [{ ...completeQueue.tracks[0], album_name: null }],
  }), true);

  const MINUTE_DB = {
    prepare(sql) {
      if (/FROM sh_queue_read_model_current/.test(sql)) previousReads += 1;
      return {
        sql,
        params: [],
        bind(...params) { this.params = params; return this; },
        async first() { return null; },
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };

  await saveMinuteFactReadModels({ MINUTE_DB }, {
    channel: { channel_id: 10, observed_at: 123_456, presentation: {} },
    queue: {
      station_id: 5,
      queue_id: 9,
      start_time: 100,
      is_paused: false,
      value: completeQueue,
    },
    collector: { collector_id: 'cloudflare-worker', updated_at: 123_456 },
  }, 'minute-fact:10:120000');

  assert.equal(previousReads, 0);
  assert.equal(batches.length, 1);
  assert.match(batches[0][1].params[6], /"album_name":"Album"/);
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
        async first() { return null; },
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

test('minute read-model save preserves metadata when source hydration is unavailable', async () => {
  const batches = [];
  const MINUTE_DB = {
    prepare(sql) {
      return {
        sql,
        params: [],
        bind(...params) { this.params = params; return this; },
        async first() {
          if (!/FROM sh_queue_read_model_current/.test(sql)) return null;
          return {
            queue_id: 9,
            start_time: 100,
            queue_json: JSON.stringify({
              tracks: [{
                position: 0,
                spotify_id: 'sp1',
                title: 'Previous Song',
                artist: 'Previous Artist',
                thumbnail_url: 'previous-cover',
              }],
            }),
          };
        },
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };

  await saveMinuteFactReadModels({ MINUTE_DB }, {
    channel: { channel_id: 10, observed_at: 123_456, presentation: {} },
    queue: {
      station_id: 5,
      queue_id: 9,
      start_time: 100,
      is_paused: false,
      value: {
        tracks: [{
          position: 0,
          spotify_id: 'sp1',
          title: null,
          artist: null,
          thumbnail_url: null,
        }],
      },
    },
    collector: { collector_id: 'cloudflare-worker', updated_at: 123_456 },
  }, 'minute-fact:10:120000');

  assert.match(batches[0][1].params[6], /"title":"Previous Song"/);
  assert.match(batches[0][1].params[6], /"artist":"Previous Artist"/);
  assert.match(batches[0][1].params[6], /"thumbnail_url":"previous-cover"/);
});
