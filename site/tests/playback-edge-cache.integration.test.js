import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequest } from '../functions/_middleware.js';

function fakeCache() {
  const values = new Map();
  return {
    async match(request) {
      const response = values.get(request.url);
      return response ? response.clone() : undefined;
    },
    async put(request, response) {
      values.set(request.url, response.clone());
    },
  };
}

async function cachedRequest(url, next, waits) {
  return onRequest({
    request: new Request(url),
    next,
    waitUntil(promise) { waits.push(promise); },
  });
}

test('buddies playback JSON is built once per five-minute edge-cache window', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  let builds = 0;
  const waits = [];
  const next = async () => Response.json({ ok: true, build: ++builds });

  try {
    const first = await cachedRequest('https://skrzk.test/api/playback?channel=buddies', next, waits);
    assert.equal(first.headers.get('x-playback-cache'), 'MISS');
    assert.match(first.headers.get('cache-control'), /s-maxage=300/);
    assert.deepEqual(await first.json(), { ok: true, build: 1 });
    await Promise.all(waits.splice(0));

    const second = await cachedRequest('https://skrzk.test/api/playback?channel=buddies', next, waits);
    assert.equal(second.headers.get('x-playback-cache'), 'HIT');
    assert.deepEqual(await second.json(), { ok: true, build: 1 });
    assert.equal(builds, 1);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('default playback aliases to buddies but buddy46 and raw requests bypass the cache', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  let builds = 0;
  const waits = [];
  const next = async () => Response.json({ ok: true, build: ++builds });

  try {
    const defaultResponse = await cachedRequest('https://skrzk.test/api/playback', next, waits);
    assert.equal(defaultResponse.headers.get('x-playback-cache'), 'MISS');
    await defaultResponse.arrayBuffer();
    await Promise.all(waits.splice(0));

    const defaultHit = await cachedRequest('https://skrzk.test/api/playback?v=2', next, waits);
    assert.equal(defaultHit.headers.get('x-playback-cache'), 'HIT');
    await defaultHit.arrayBuffer();

    const buddy46 = await cachedRequest('https://skrzk.test/api/playback?channel=buddy46', next, waits);
    assert.equal(buddy46.headers.get('x-playback-cache'), null);
    await buddy46.arrayBuffer();

    const raw = await cachedRequest('https://skrzk.test/api/playback?channel=buddies&raw=1', next, waits);
    assert.equal(raw.headers.get('x-playback-cache'), null);
    await raw.arrayBuffer();

    assert.equal(builds, 3);
  } finally {
    globalThis.caches = previousCaches;
  }
});
