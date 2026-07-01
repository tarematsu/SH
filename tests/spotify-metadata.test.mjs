import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchSpotifyMetadata,
  fetchSpotifyMetadataBatch,
  parseSpotifyTitle,
} from '../site/functions/lib/spotify-metadata.js';

function memoryCache() {
  const values = new Map();
  return {
    async match(request) {
      const value = values.get(request.url);
      return value?.clone();
    },
    async put(request, response) {
      values.set(request.url, response.clone());
    },
  };
}

async function withGlobals(fetchImpl, callback) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = fetchImpl;
  globalThis.caches = { default: memoryCache() };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

test('Spotify title parser removes service suffix and extracts artist', () => {
  assert.deepEqual(parseSpotifyTitle('Song - song and lyrics by Artist | Spotify'), {
    title: 'Song',
    artist: 'Artist',
  });
});

test('simultaneous metadata requests for one track share a single fetch', async () => {
  let calls = 0;
  await withGlobals(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ title: 'Track | Spotify', author_name: 'Artist' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, async () => {
    const id = 'dedupe-track-20260701';
    const [first, second] = await Promise.all([
      fetchSpotifyMetadata(id),
      fetchSpotifyMetadata(id),
    ]);
    assert.equal(calls, 1);
    assert.equal(first.title, 'Track');
    assert.deepEqual(second, first);
  });
});

test('batch metadata resolution removes duplicate ids and bounds work', async () => {
  let calls = 0;
  await withGlobals(async (request) => {
    calls += 1;
    const requestUrl = typeof request === 'string' ? request : request.url;
    const id = new URL(requestUrl).searchParams.get('url').split('/').at(-1);
    return new Response(JSON.stringify({ title: `${id} title`, author_name: 'Artist' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, async () => {
    const resolved = await fetchSpotifyMetadataBatch([
      'batch-track-a-20260701',
      'batch-track-a-20260701',
      'batch-track-b-20260701',
    ], { concurrency: 2 });
    assert.equal(calls, 2);
    assert.equal(resolved.size, 2);
  });
});
