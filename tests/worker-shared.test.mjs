import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStationheadReadFetch,
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

test('duplicate Stationhead station and comment reads share one response per minute', async () => {
  let now = 120_000;
  let calls = 0;
  const nativeFetch = async (input) => {
    const call = ++calls;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ call, url: String(input) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const cachedFetch = createStationheadReadFetch(nativeFetch, () => now);
  const headers = { authorization: 'Bearer token', 'sth-device-uid': 'device' };
  const stationUrl = 'https://production1.stationhead.com/station/handle/sakurazaka46jp/guest';
  const commentsUrl = 'https://production1.stationhead.com/station/123/chatHistory?limit=50';

  const responses = await Promise.all([
    cachedFetch(stationUrl, { method: 'POST', headers, body: '{}' }),
    cachedFetch(stationUrl, { method: 'POST', headers, body: '{}' }),
    cachedFetch(commentsUrl, { headers }),
    cachedFetch(commentsUrl, { headers }),
  ]);
  assert.equal(calls, 2);
  assert.deepEqual((await Promise.all(responses.map((response) => response.json()))).map((value) => value.call), [1, 1, 2, 2]);

  await cachedFetch(stationUrl, { method: 'POST', headers, body: '{}' });
  assert.equal(calls, 2);
  now += 60_000;
  await cachedFetch(stationUrl, { method: 'POST', headers, body: '{}' });
  assert.equal(calls, 3);
});

test('failed Stationhead reads are not retained after the in-flight request', async () => {
  let calls = 0;
  const cachedFetch = createStationheadReadFetch(async () => {
    calls += 1;
    return new Response('failed', { status: 503 });
  }, () => 120_000);
  const url = 'https://production1.stationhead.com/station/handle/sakurazaka46jp/guest';
  const init = { method: 'POST', headers: { authorization: 'Bearer token', 'sth-device-uid': 'device' }, body: '{}' };
  assert.equal((await cachedFetch(url, init)).status, 503);
  assert.equal((await cachedFetch(url, init)).status, 503);
  assert.equal(calls, 2);
});

test('worker JSON responses do not add pretty-print transfer bytes', async () => {
  const response = jsonResponse({ ok: true, count: 1 });
  assert.equal(await response.text(), '{"ok":true,"count":1}');
});
