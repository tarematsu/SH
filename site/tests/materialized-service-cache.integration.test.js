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

class ThrowingDb {
  prepare() {
    throw new Error('D1 should not be read when the KV service hits');
  }
}

class MaterializedDb {
  constructor(now) {
    this.now = now;
    this.calls = 0;
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
        db.calls += 1;
        if (!sql.includes('sh_pages_response_manifest')) return null;
        return {
          generation: 'fallback-generation',
          status: 200,
          headers_json: JSON.stringify({ 'content-type': 'application/json; charset=utf-8' }),
          chunk_count: 1,
          updated_at: db.now,
        };
      },
      async all() {
        db.calls += 1;
        return { results: [{ payload_chunk: JSON.stringify({ ok: true, source: 'd1' }) }] };
      },
    };
  }
}

async function request(url, env, waits, next = async () => Response.json({ source: 'live' })) {
  return onRequest({
    request: new Request(url),
    env,
    next,
    waitUntil(promise) { waits.push(promise); },
  });
}

test('Cache API miss uses the KV service without D1 and caches six-hour models for 30 minutes', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  const waits = [];
  const now = Date.now();
  let serviceCalls = 0;
  let liveCalls = 0;
  const service = {
    async fetch(input) {
      serviceCalls += 1;
      assert.equal(new URL(input.url).searchParams.get('key'), 'history:daily');
      return Response.json({ ok: true, source: 'kv' }, {
        headers: {
          'x-api-source': 'worker-kv',
          'x-materialized-at': String(now),
          'x-materialized-cadence-seconds': '21600',
        },
      });
    },
  };

  try {
    const first = await request(
      'https://skrzk.test/api/history?mode=daily',
      { PAGES_READ_MODEL_SERVICE: service, MINUTE_DB: new ThrowingDb() },
      waits,
      async () => {
        liveCalls += 1;
        return Response.json({ source: 'live' });
      },
    );
    assert.equal(first.headers.get('x-edge-cache'), 'MISS');
    assert.equal(first.headers.get('x-api-source'), 'worker-kv');
    assert.ok([1799, 1800].includes(sharedTtl(first)));
    assert.deepEqual(await first.json(), { ok: true, source: 'kv' });
    assert.equal(serviceCalls, 1);
    assert.equal(liveCalls, 0);
    await Promise.all(waits.splice(0));

    const second = await request(
      'https://skrzk.test/api/history?mode=daily&v=2',
      { PAGES_READ_MODEL_SERVICE: service, MINUTE_DB: new ThrowingDb() },
      waits,
    );
    assert.equal(second.headers.get('x-edge-cache'), 'HIT');
    assert.equal(serviceCalls, 1);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('KV service misses fall back to the existing D1 materialized response', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  const waits = [];
  const now = Date.now();
  const db = new MaterializedDb(now);

  try {
    const response = await request(
      'https://skrzk.test/api/history?mode=daily',
      { PAGES_READ_MODEL_SERVICE: { fetch: async () => new Response(null, { status: 404 }) }, MINUTE_DB: db },
      waits,
    );
    assert.equal(response.headers.get('x-api-source'), 'worker-materialized');
    assert.deepEqual(await response.json(), { ok: true, source: 'd1' });
    assert.equal(db.calls, 2);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('D1-only track history does not spend a KV read or service subrequest', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  const waits = [];
  const now = Date.now();
  const db = new MaterializedDb(now);
  let serviceCalls = 0;

  try {
    const response = await request(
      'https://skrzk.test/api/track-history',
      {
        PAGES_READ_MODEL_SERVICE: {
          fetch: async () => {
            serviceCalls += 1;
            return new Response(null, { status: 404 });
          },
        },
        MINUTE_DB: db,
      },
      waits,
    );
    assert.equal(response.headers.get('x-api-source'), 'worker-materialized');
    assert.equal(serviceCalls, 0);
    assert.equal(db.calls, 2);
  } finally {
    globalThis.caches = previousCaches;
  }
});
