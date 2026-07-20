import assert from 'node:assert/strict';
import test from 'node:test';

import { runPagesReadModelFetch } from '../src/pages-read-model-entry.js';
import {
  loadMaterializedResponse,
  pagesResponseKey,
  saveMaterializedResponse,
} from '../src/pages-response-store.js';
import { runPagesSixHourTask } from '../src/pages-six-hour-read-model.js';
import {
  ensurePagesResponseNamespace,
  namespaceIdFromList,
  pagesReadModelConfigWithNamespaceId,
} from '../scripts/pages-response-kv-namespace.mjs';

class FakeKv {
  constructor() { this.values = new Map(); }
  async put(key, value, options) {
    this.values.set(key, { value, metadata: options?.metadata });
  }
  async getWithMetadata(key, options) {
    assert.deepEqual(options, { type: 'stream', cacheTtl: 300 });
    const stored = this.values.get(key);
    if (!stored) return { value: null, metadata: null };
    return {
      value: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stored.value));
          controller.close();
        },
      }),
      metadata: stored.metadata,
    };
  }
}

class NoD1Db {
  prepare() { throw new Error('D1 response storage must not run on a KV hit'); }
}

class FakeEdgeCache {
  constructor() { this.response = null; this.puts = 0; }
  async match() { return this.response?.clone() || undefined; }
  async put(_key, response) {
    this.response = response;
    this.puts += 1;
  }
}

test('materialized responses publish once to KV and are served as streams', async () => {
  const kv = new FakeKv();
  const now = Date.UTC(2026, 6, 20, 0, 35);
  const saved = await saveMaterializedResponse(
    new NoD1Db(),
    kv,
    'history:daily',
    Response.json({ ok: true, rows: [1, 2, 3] }),
    now,
    21_600,
  );
  assert.equal(saved.storage, 'kv');
  assert.ok(kv.values.has(pagesResponseKey('history:daily')));

  const response = await loadMaterializedResponse(kv, 'history:daily', now + 60_000, 21_900_000);
  assert.equal(response.headers.get('x-api-source'), 'worker-kv');
  assert.deepEqual(await response.json(), { ok: true, rows: [1, 2, 3] });
});

test('the internal Worker endpoint returns a KV response or a closed fallback signal', async () => {
  const now = Date.UTC(2026, 6, 20, 0, 35);
  const hit = await runPagesReadModelFetch(
    new Request('https://internal.test/_internal/pages-response?key=history%3Adaily'),
    { PAGES_RESPONSE_KV: {} },
    {
      now: () => now,
      loadResponse: async () => Response.json({ source: 'kv' }),
    },
  );
  assert.equal(hit.status, 200);
  assert.deepEqual(await hit.json(), { source: 'kv' });

  const miss = await runPagesReadModelFetch(
    new Request('https://internal.test/_internal/pages-response?key=history%3Adaily'),
    {},
    { loadResponse: async () => null },
  );
  assert.equal(miss.status, 404);
});

test('the internal Worker endpoint uses Cache API as a same-colo L1 before KV', async () => {
  const cache = new FakeEdgeCache();
  const now = Date.UTC(2026, 6, 20, 0, 35);
  const request = new Request('https://internal.test/_internal/pages-response?key=history%3Adaily');
  const first = await runPagesReadModelFetch(request, {}, {
    cache,
    now: () => now,
    loadResponse: async () => {
      const response = Response.json({ source: 'kv' });
      response.headers.set('x-materialized-at', String(now));
      return response;
    },
  });
  assert.equal(first.headers.get('x-api-source'), null);
  assert.equal(cache.puts, 1);

  let kvReads = 0;
  const second = await runPagesReadModelFetch(request, {}, {
    cache,
    now: () => now + 1_000,
    loadResponse: async () => {
      kvReads += 1;
      return null;
    },
  });
  assert.equal(second.headers.get('x-api-source'), 'edge-cache');
  assert.equal(kvReads, 0);
  assert.deepEqual(await second.json(), { source: 'kv' });
});

test('the internal Worker endpoint schedules Cache API writes on the real execution context', async () => {
  const cache = new FakeEdgeCache();
  const waits = [];
  const now = Date.UTC(2026, 6, 20, 0, 35);
  const response = await runPagesReadModelFetch(
    new Request('https://internal.test/_internal/pages-response?key=history%3Adaily'),
    {},
    { waitUntil(promise) { waits.push(promise); } },
    {
      cache,
      now: () => now,
      loadResponse: async () => {
        const result = Response.json({ source: 'kv' });
        result.headers.set('x-materialized-at', String(now));
        return result;
      },
    },
  );
  assert.equal(response.status, 200);
  await Promise.all(waits);
  assert.equal(cache.puts, 1);
});

test('six-hour variants use KV without provisioning D1 response tables', async () => {
  const calls = [];
  const now = Date.UTC(2026, 6, 20, 0, 35);
  const result = await runPagesSixHourTask({
    BUDDIES_DB: {},
    MINUTE_DB: { prepare: () => ({ run: async () => {} }) },
    OTHER_DB: {},
    PAGES_RESPONSE_KV: { put() {} },
  }, now, {
    ensureSchema: async () => {},
    render: async () => Response.json({ ok: true }),
    saveResponse: async (...args) => {
      calls.push(args);
      return { storage: 'kv', bytes: 11, chunks: 1 };
    },
  });
  assert.equal(result.failed, 0);
  assert.equal(result.responses[0].storage, 'kv');
  assert.equal(calls[0][2], 'history:daily');
  assert.equal(calls[0][5], 21_600);
});

test('deployment resolves the exact namespace and replaces the placeholder id', () => {
  const title = 'sh-pages-read-model-pages-response-kv';
  assert.equal(namespaceIdFromList({ result: [
    { id: 'other', title: 'other' },
    { id: 'pages-id', title },
  ] }), 'pages-id');
  const rendered = JSON.parse(pagesReadModelConfigWithNamespaceId(JSON.stringify({
    kv_namespaces: [{ binding: 'PAGES_RESPONSE_KV', id: 'placeholder' }],
  }), 'pages-id'));
  assert.equal(rendered.kv_namespaces[0].id, 'pages-id');
});

test('deployment searches every namespace page before creating a new namespace', async () => {
  const title = 'sh-pages-read-model-pages-response-kv';
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method });
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 1) {
      return Response.json({
        success: true,
        result: Array.from({ length: 1000 }, (_, index) => ({ id: `other-${index}`, title: `other-${index}` })),
        result_info: { page: 1, per_page: 1000, total_count: 1001 },
      });
    }
    return Response.json({
      success: true,
      result: [{ id: 'pages-id', title }],
      result_info: { page: 2, per_page: 1000, total_count: 1001 },
    });
  };
  const namespace = await ensurePagesResponseNamespace({
    accountId: 'account',
    apiToken: 'token',
    fetch,
  });
  assert.deepEqual(namespace, { id: 'pages-id', title, created: false });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ method }) => method), ['GET', 'GET']);
  assert.match(requests[1].url, /page=2/);
});
