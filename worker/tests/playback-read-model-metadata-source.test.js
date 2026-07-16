import assert from 'node:assert/strict';
import test from 'node:test';

import { loadReadModelTrackMetadata } from '../src/minute-facts-read-model.js';

function metadataDb(rows, calls, name) {
  return {
    prepare(sql) {
      calls.push({ name, sql, bindings: [] });
      const call = calls.at(-1);
      return {
        bind(...bindings) {
          call.bindings = bindings;
          return this;
        },
        async all() {
          return { results: rows };
        },
      };
    },
  };
}

test('playback read-model hydration prefers MINUTE_DB metadata', async () => {
  const calls = [];
  const rows = await loadReadModelTrackMetadata({
    MINUTE_DB: metadataDb([{
      spotify_id: 'sp1',
      isrc: 'JPX1',
      title: 'Song',
      artist: 'Artist',
      thumbnail_url: 'https://img.example/cover.jpg',
      fetched_at: 20,
    }], calls, 'minute'),
    BUDDIES_DB: metadataDb([{
      spotify_id: 'sp1',
      isrc: 'JPX1',
      title: 'Old Song',
      artist: 'Old Artist',
      thumbnail_url: null,
      fetched_at: 10,
    }], calls, 'buddies'),
  }, ['sp1'], ['JPX1']);

  assert.equal(rows[0].title, 'Song');
  assert.equal(rows[0].artist, 'Artist');
  assert.equal(rows[0].thumbnail_url, 'https://img.example/cover.jpg');
  assert.deepEqual(calls.map((call) => call.name), ['minute']);
});

test('playback read-model hydration falls back for identifiers missing in MINUTE_DB', async () => {
  const calls = [];
  const rows = await loadReadModelTrackMetadata({
    MINUTE_DB: metadataDb([{
      spotify_id: 'sp1',
      isrc: 'JPX1',
      title: 'Song 1',
      artist: 'Artist 1',
      thumbnail_url: 'cover-1',
      fetched_at: 20,
    }], calls, 'minute'),
    BUDDIES_DB: metadataDb([{
      spotify_id: 'sp2',
      isrc: 'JPX2',
      title: 'Song 2',
      artist: 'Artist 2',
      thumbnail_url: 'cover-2',
      fetched_at: 10,
    }], calls, 'buddies'),
  }, ['sp1', 'sp2'], ['JPX1', 'JPX2']);

  assert.deepEqual(rows.map((row) => row.spotify_id), ['sp1', 'sp2']);
  assert.deepEqual(calls.map((call) => call.name), ['minute', 'buddies']);
  assert.deepEqual(calls[1].bindings, ['JPX2', 'sp2']);
});
