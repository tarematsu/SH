import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enrichTracks,
  fetchTrackMetadata,
  jsonResponse,
  resetTrackMetadataQueueCache,
} from '../worker/src/shared.js';

async function withFetch(fetchImpl, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await callback(); } finally { globalThis.fetch = originalFetch; }
}

test('Apple metadata lookup skips US when JP already resolves the track', async () => {
  const countries = [];
  await withFetch(async (request) => {
    const url = new URL(typeof request === 'string' ? request : request.url);
    if (url.hostname === 'itunes.apple.com') {
      countries.push(url.searchParams.get('country'));
      return new Response(JSON.stringify({ results: [{ kind: 'song', trackName: 'Track', artistName: 'Artist' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ title: 'Song | Spotify', author_name: 'Artist' }), { status: 200 });
  }, async () => {
    const value = await fetchTrackMetadata({ apple_music_id: '1', spotify_id: 'spotify-1' }, { requestTimeoutMs: 1000 });
    assert.equal(value.title, 'Track');
    assert.deepEqual(countries, ['JP']);
  });
});

test('Apple metadata lookup falls back to US only after JP misses', async () => {
  const countries = [];
  await withFetch(async (request) => {
    const url = new URL(typeof request === 'string' ? request : request.url);
    if (url.hostname === 'itunes.apple.com') {
      const country = url.searchParams.get('country');
      countries.push(country);
      return new Response(JSON.stringify({ results: country === 'US' ? [{ kind: 'song', trackName: 'Track', artistName: 'Artist' }] : [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ title: 'Track | Spotify', author_name: 'Artist' }), { status: 200 });
  }, async () => {
    const value = await fetchTrackMetadata({ apple_music_id: '2', spotify_id: 'spotify-2' }, { requestTimeoutMs: 1000 });
    assert.equal(value.title, 'Track');
    assert.deepEqual(countries, ['JP', 'US']);
  });
});

test('completed queue metadata skips repeated D1 lookups', async () => {
  resetTrackMetadataQueueCache();
  let queries = 0;
  const env = {
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async all() {
            queries += 1;
            return { results: [{ spotify_id: 'spotify-1', title: 'Track', artist: 'Artist' }] };
          },
        };
      },
    },
  };
  const queue = { tracks: [{ spotify_id: 'spotify-1' }] };
  const ingest = async () => assert.fail('complete metadata must not trigger ingest');
  const config = { metadataLimit: 3, requestTimeoutMs: 1000 };

  assert.equal(await enrichTracks(env, ingest, queue, 1000, config), 0);
  assert.equal(await enrichTracks(env, ingest, queue, 2000, config), 0);
  assert.equal(queries, 1);
});

test('worker JSON responses do not add pretty-print transfer bytes', async () => {
  const response = jsonResponse({ ok: true, count: 1 });
  assert.equal(await response.text(), '{"ok":true,"count":1}');
});
