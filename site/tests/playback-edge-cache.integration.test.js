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

class MaterializedDb {
  constructor({ body = '{"ok":true,"source":"cron"}', updatedAt = Date.now() } = {}) {
    this.body = body;
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
          generation: 'generation-1',
          status: 200,
          headers_json: JSON.stringify({ 'content-type': 'application/json; charset=utf-8' }),
          chunk_count: 2,
          updated_at: db.updatedAt,
        };
      },
      async all() {
        db.calls.push({ method: 'all', sql, params: this.params });
        if (!sql.includes('sh_pages_response_chunks')) return { results: [] };
        const split = Math.floor(db.body.length / 2);
        return { results: [
          { payload_chunk: db.body.slice(0, split) },
          { payload_chunk: db.body.slice(split) },
        ] };
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

test('buddies playback is created by cron and served from edge cache without running the endpoint', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  let liveBuilds = 0;
  const waits = [];
  const db = new MaterializedDb();
  const next = async () => Response.json({ ok: true, build: ++liveBuilds });

  try {
    const first = await cachedRequest(
      'https://skrzk.test/api/playback?channel=buddies',
      next,
      waits,
      { MINUTE_DB: db },
    );
    assert.equal(first.headers.get('x-edge-cache'), 'MISS');
    assert.equal(first.headers.get('x-api-source'), 'worker-materialized');
    assert.match(first.headers.get('cache-control'), /s-maxage=300/);
    assert.deepEqual(await first.json(), { ok: true, source: 'cron' });
    assert.equal(liveBuilds, 0);
    await Promise.all(waits.splice(0));

    const second = await cachedRequest(
      'https://skrzk.test/api/playback?v=2',
      next,
      waits,
      { MINUTE_DB: db },
    );
    assert.equal(second.headers.get('x-edge-cache'), 'HIT');
    assert.deepEqual(await second.json(), { ok: true, source: 'cron' });
    assert.equal(liveBuilds, 0);
    assert.equal(db.calls.filter((call) => call.method === 'first').length, 1);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('non-materialized public APIs are still coalesced and cached for five minutes', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  let builds = 0;
  const waits = [];
  const next = async () => Response.json({ ok: true, build: ++builds });

  try {
    const first = await cachedRequest('https://skrzk.test/api/broadcast-series?id=7', next, waits);
    assert.equal(first.headers.get('x-edge-cache'), 'MISS');
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
