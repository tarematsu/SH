import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequest } from '../functions/_middleware.js';

function memoryCache() {
  const values = new Map();
  return {
    async match(request) {
      const value = values.get(request.url);
      return value ? value.clone() : undefined;
    },
    async put(request, response) { values.set(request.url, response.clone()); },
  };
}

class ThrowingDb {
  prepare() { throw new Error('D1 must not run when the KV service responds'); }
}

test('a cache miss serves compact materializations through the KV service before D1', async () => {
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: memoryCache() };
  const waits = [];
  const now = Date.now();
  let serviceCalls = 0;
  let liveCalls = 0;
  try {
    const response = await onRequest({
      request: new Request('https://skrzk.test/api/history?mode=daily'),
      env: {
        MINUTE_DB: new ThrowingDb(),
        PAGES_READ_MODEL_SERVICE: {
          async fetch(request) {
            serviceCalls += 1;
            assert.equal(new URL(request.url).searchParams.get('key'), 'history:daily');
            return Response.json({ source: 'kv' }, {
              headers: {
                'x-api-source': 'worker-kv',
                'x-materialized-at': String(now),
                'x-materialized-cadence-seconds': '21600',
              },
            });
          },
        },
      },
      async next() {
        liveCalls += 1;
        return Response.json({ source: 'live' });
      },
      waitUntil(promise) { waits.push(promise); },
    });
    assert.equal(response.headers.get('x-api-source'), 'worker-kv');
    assert.equal(response.headers.get('x-edge-cache'), 'MISS');
    assert.deepEqual(await response.json(), { source: 'kv' });
    assert.equal(serviceCalls, 1);
    assert.equal(liveCalls, 0);
    await Promise.all(waits);
  } finally {
    globalThis.caches = originalCaches;
  }
});

test('track-history remains on D1 and does not spend a KV read', async () => {
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: memoryCache() };
  let serviceCalls = 0;
  try {
    const response = await onRequest({
      request: new Request('https://skrzk.test/api/track-history'),
      env: {
        PAGES_READ_MODEL_SERVICE: { fetch: async () => { serviceCalls += 1; } },
      },
      next: async () => Response.json({ source: 'live' }),
      waitUntil() {},
    });
    assert.equal(response.status, 200);
    assert.equal(serviceCalls, 0);
  } finally {
    globalThis.caches = originalCaches;
  }
});
