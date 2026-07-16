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

function sharedTtl(response) {
  const match = /(?:^|,\s*)s-maxage=(\d+)/.exec(response.headers.get('cache-control') || '');
  return match ? Number(match[1]) : null;
}

function assertFiveMinuteTtl(response) {
  const ttl = sharedTtl(response);
  assert.ok(ttl === 299 || ttl === 300, `expected five-minute TTL, got ${ttl}`);
}

class MaterializedDb {
  constructor({ updatedAt = Date.now() } = {}) {
    this.updatedAt = updatedAt;
    this.calls = [];
  }

  prepare(sql) {
    const db = this;
    return {
      params: [],
      bind(...params) {
        this.params = params;
        return this;
      },
      async first() {
        db.calls.push({ method: 'first', sql, params: this.params });
        if (!sql.includes('sh_pages_response_manifest')) return null;
        return {
          generation: `generation:${this.params[0]}`,
          status: 200,
          headers_json: JSON.stringify({ 'content-type': 'application/json; charset=utf-8' }),
          chunk_count: 1,
          updated_at: db.updatedAt,
        };
      },
      async all() {
        db.calls.push({ method: 'all', sql, params: this.params });
        if (!sql.includes('sh_pages_response_chunks')) return { results: [] };
        return { results: [{
          payload_chunk: JSON.stringify({ ok: true, model_key: this.params[0] }),
        }] };
      },
    };
  }
}

async function cachedRequest(url, next, waits, env = {}) {
  return onRequest({
    request: new Request(url),
    env,
    next,
    waitUntil(promise) { waits.push(promise); },
  });
}

test('buddies and buddy46 playback are generated live and cached for five minutes', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  let liveBuilds = 0;
  const waits = [];
  const db = new MaterializedDb();
  const next = async () => Response.json({ ok: true, build: ++liveBuilds });

  try {
    const buddies = await cachedRequest(
      'https://skrzk.test/api/playback?channel=buddies',
      next,
      waits,
      { MINUTE_DB: db },
    );
    assert.equal(buddies.headers.get('x-edge-cache'), 'MISS');
    assert.equal(buddies.headers.get('x-api-source'), null);
    assertFiveMinuteTtl(buddies);
    assert.deepEqual(await buddies.json(), { ok: true, build: 1 });
    assert.equal(db.calls.length, 0);
    await Promise.all(waits.splice(0));

    const buddiesHit = await cachedRequest(
      'https://skrzk.test/api/playback?v=2',
      next,
      waits,
      { MINUTE_DB: db },
    );
    assert.equal(buddiesHit.headers.get('x-edge-cache'), 'HIT');
    assert.deepEqual(await buddiesHit.json(), { ok: true, build: 1 });

    const buddy46 = await cachedRequest(
      'https://skrzk.test/api/playback?channel=buddy46',
      next,
      waits,
      { MINUTE_DB: db },
    );
    assert.equal(buddy46.headers.get('x-edge-cache'), 'MISS');
    assert.equal(buddy46.headers.get('x-api-source'), null);
    assertFiveMinuteTtl(buddy46);
    assert.deepEqual(await buddy46.json(), { ok: true, build: 2 });
    assert.equal(db.calls.length, 0);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('non-playback public APIs can still use materialized responses', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  let liveBuilds = 0;
  const waits = [];
  const db = new MaterializedDb();
  const next = async () => Response.json({ ok: true, build: ++liveBuilds });

  try {
    const response = await cachedRequest(
      'https://skrzk.test/api/dashboard',
      next,
      waits,
      { MINUTE_DB: db },
    );
    assert.equal(response.headers.get('x-edge-cache'), 'MISS');
    assert.equal(response.headers.get('x-api-source'), 'worker-materialized');
    assertFiveMinuteTtl(response);
    assert.deepEqual(await response.json(), { ok: true, model_key: 'dashboard' });
    assert.equal(liveBuilds, 0);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('non-playback public APIs are coalesced and cached for five minutes', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  let builds = 0;
  const waits = [];
  const next = async () => Response.json({ ok: true, build: ++builds });

  try {
    const first = await cachedRequest('https://skrzk.test/api/broadcast-series?id=7', next, waits);
    assert.equal(first.headers.get('x-edge-cache'), 'MISS');
    assertFiveMinuteTtl(first);
    assert.deepEqual(await first.json(), { ok: true, build: 1 });
    await Promise.all(waits.splice(0));

    const second = await cachedRequest('https://skrzk.test/api/broadcast-series?id=7&v=9', next, waits);
    assert.equal(second.headers.get('x-edge-cache'), 'HIT');
    assert.deepEqual(await second.json(), { ok: true, build: 1 });
    assert.equal(builds, 1);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('health, freshness, recovery, and raw requests remain immediate', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  let builds = 0;
  const waits = [];
  const next = async () => Response.json({ ok: true, build: ++builds });

  try {
    for (const url of [
      'https://skrzk.test/api/health',
      'https://skrzk.test/api/minute-facts/latest',
      'https://skrzk.test/api/dashboard-recovery',
      'https://skrzk.test/api/history?mode=raw',
      'https://skrzk.test/api/playback?raw=1',
    ]) {
      const response = await cachedRequest(url, next, waits);
      assert.equal(response.headers.get('x-edge-cache'), null);
      await response.arrayBuffer();
    }
    assert.equal(builds, 5);
  } finally {
    globalThis.caches = previousCaches;
  }
});
