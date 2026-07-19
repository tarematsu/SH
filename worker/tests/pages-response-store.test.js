import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadMaterializedResponse,
  pagesResponseKey,
  saveMaterializedResponse,
} from '../src/pages-response-store.js';

class FakeKv {
  constructor() {
    this.values = new Map();
    this.getOptions = [];
  }

  async put(key, value, options) {
    this.values.set(key, { value, metadata: options?.metadata || null });
  }

  async getWithMetadata(key, options) {
    this.getOptions.push(options);
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

class FakeDb {
  prepare() {
    throw new Error('D1 should not be used on a KV publish');
  }
}

test('materialized responses use one KV write and stream reads', async () => {
  const kv = new FakeKv();
  const now = Date.UTC(2026, 6, 20, 0, 35);
  const saved = await saveMaterializedResponse(
    new FakeDb(),
    kv,
    'history:daily',
    Response.json({ ok: true, rows: [1, 2, 3] }),
    now,
    21_600,
  );

  assert.deepEqual(saved, { bytes: 26, chunks: 1, storage: 'kv' });
  assert.equal(kv.values.size, 1);
  assert.ok(kv.values.has(pagesResponseKey('history:daily')));

  const response = await loadMaterializedResponse(kv, 'history:daily', now + 60_000, 21_900_000);
  assert.equal(response.headers.get('x-api-source'), 'worker-kv');
  assert.equal(response.headers.get('x-materialized-at'), String(now));
  assert.equal(response.headers.get('x-materialized-cadence-seconds'), '21600');
  assert.deepEqual(await response.json(), { ok: true, rows: [1, 2, 3] });
  assert.deepEqual(kv.getOptions, [{ type: 'stream', cacheTtl: 300 }]);
});

test('stale KV responses are rejected without a D1 operation', async () => {
  const kv = new FakeKv();
  const now = Date.UTC(2026, 6, 20, 0, 35);
  await saveMaterializedResponse(
    new FakeDb(),
    kv,
    'history:daily',
    Response.json({ ok: true }),
    now,
    21_600,
  );

  assert.equal(
    await loadMaterializedResponse(kv, 'history:daily', now + 21_900_001, 21_900_000),
    null,
  );
});

class RecordingDb {
  constructor() { this.calls = []; }
  prepare(sql) {
    const db = this;
    return {
      params: [],
      bind(...params) { this.params = params; return this; },
      async run() {
        db.calls.push({ method: 'run', sql, params: this.params });
        return { meta: { changes: 1 } };
      },
    };
  }
  async batch(statements) {
    this.calls.push({ method: 'batch', count: statements.length });
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

test('KV quota or write failures fall back to the existing D1 response format', async () => {
  const db = new RecordingDb();
  const saved = await saveMaterializedResponse(
    db,
    { put: async () => { throw new Error('KV daily limit'); } },
    'history:weekly',
    Response.json({ ok: true }),
    Date.UTC(2026, 6, 20, 1, 10),
    21_600,
  );

  assert.equal(saved.storage, 'd1');
  assert.ok(db.calls.some(({ sql = '' }) => sql.includes('CREATE TABLE IF NOT EXISTS sh_pages_response_manifest')));
  assert.ok(db.calls.some(({ sql = '' }) => sql.includes('INSERT INTO sh_pages_response_manifest')));
  assert.ok(db.calls.some(({ sql = '' }) => sql.includes('INSERT INTO sh_pages_response_chunks')));
});
