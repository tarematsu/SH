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
