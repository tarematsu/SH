import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MATERIALIZED_API_VARIANTS,
  materializedResponseCadenceSeconds,
  materializedResponseMaximumAge,
} from '../../site/functions/lib/api-contract.js';
import {
  refreshFastPagesReadModels,
  refreshTrackHistoryPagesReadModel,
} from '../src/pages-read-model-refresh.js';

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async run() {
    this.db.calls.push({ method: 'run', sql: this.sql, params: this.params });
    return { success: true, meta: { changes: 1 } };
  }

  async all() {
    this.db.calls.push({ method: 'all', sql: this.sql, params: this.params });
    return { results: [] };
  }

  async first() {
    this.db.calls.push({ method: 'first', sql: this.sql, params: this.params });
    return null;
  }
}

class FakeDb {
  constructor() {
    this.calls = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    this.calls.push({ method: 'batch', statements: statements.length });
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

test('materialized API contracts retain six-hour responses through their next cycle', () => {
  const sixHourKeys = MATERIALIZED_API_VARIANTS
    .filter(({ key }) => key !== 'host-history:summary')
    .map(({ key, cadence_minutes: cadence }) => [key, cadence]);
  assert.equal(sixHourKeys.length, 9);
  assert.equal(sixHourKeys.every(([, cadence]) => cadence === 360), true);
  assert.equal(materializedResponseCadenceSeconds('history:daily'), 6 * 60 * 60);
  assert.equal(materializedResponseMaximumAge('history:daily'), (6 * 60 + 5) * 60_000);
});

test('midnight compatibility refresh stores every due non-history response as generation-safe chunks', async () => {
  const db = new FakeDb();
  const env = { BUDDIES_DB: {}, MINUTE_DB: db, OTHER_DB: {} };
  const now = Date.UTC(2026, 6, 16, 0);
  const result = await refreshFastPagesReadModels(env, now, {
    render: async (variant) => Response.json({
      ok: true,
      model_key: variant.key,
      generated_at: now,
    }),
  });
  const expectedResponses = MATERIALIZED_API_VARIANTS.length - 1;

  assert.equal(result.skipped, false);
  assert.equal(result.succeeded, expectedResponses);
  assert.equal(result.failed, 0);
  assert.equal(result.responses.length, expectedResponses);
  assert.equal(result.responses.some(({ key }) => key === 'track-history'), false);
  const manifestWrites = db.calls.filter((call) =>
    call.method === 'run' && call.sql.includes('INSERT INTO sh_pages_response_manifest'));
  const chunkWrites = db.calls.filter((call) =>
    call.method === 'run' && call.sql.includes('INSERT INTO sh_pages_response_chunks'));
  const oldGenerationDeletes = db.calls.filter((call) =>
    call.method === 'run' && call.sql.includes('generation<>'));
  assert.equal(manifestWrites.length, expectedResponses);
  assert.equal(chunkWrites.length, expectedResponses);
  assert.equal(oldGenerationDeletes.length, expectedResponses);
  assert.ok(db.calls.some((call) => call.method === 'run'
    && call.sql.includes('CREATE TABLE IF NOT EXISTS sh_pages_response_manifest')));
});

test('compatibility refresh stays idle between six-hour response generations', async () => {
  const db = new FakeDb();
  const result = await refreshFastPagesReadModels({
    BUDDIES_DB: {},
    MINUTE_DB: db,
    OTHER_DB: {},
  }, Date.UTC(2026, 6, 16, 12, 5), {
    render: async (variant) => Response.json({ ok: true, model_key: variant.key }),
  });

  assert.deepEqual(result.responses, []);
  assert.deepEqual(result.daily, { skipped: true, reason: 'not-due' });
  assert.deepEqual(result.likes, { skipped: true, reason: 'not-due' });
  const payloadWrites = db.calls.filter((call) =>
    call.method === 'run' && call.sql.includes('INSERT INTO sh_pages_payload_read_model'));
  assert.equal(payloadWrites.length, 0);
});

test('quarter-hour compatibility repair refreshes only the daily source payload', async () => {
  const db = new FakeDb();
  const result = await refreshFastPagesReadModels({
    BUDDIES_DB: {},
    MINUTE_DB: db,
    OTHER_DB: {},
  }, Date.UTC(2026, 6, 16, 12, 15), {
    render: async (variant) => Response.json({ ok: true, model_key: variant.key }),
  });

  assert.deepEqual(result.responses, []);
  assert.equal(result.daily.skipped, undefined);
  assert.deepEqual(result.likes, { skipped: true, reason: 'not-due' });
  const payloadWrites = db.calls.filter((call) =>
    call.method === 'run' && call.sql.includes('INSERT INTO sh_pages_payload_read_model'));
  assert.equal(payloadWrites.length, 1);
});

test('full history refresh republishes track history after updating its source table', async () => {
  const db = new FakeDb();
  const order = [];
  const now = Date.UTC(2026, 6, 16, 12, 31);
  const result = await refreshTrackHistoryPagesReadModel({
    BUDDIES_DB: {},
    MINUTE_DB: db,
  }, now, {
    refreshTracks: async () => {
      order.push('tracks');
      return { recent: { rows: 2 }, backfill: null };
    },
    render: async (variant) => {
      order.push(`render:${variant.key}`);
      return Response.json({ ok: true, model_key: variant.key, generated_at: now });
    },
  });

  assert.deepEqual(order, ['tracks', 'render:track-history']);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.responses.map(({ key }) => key), ['track-history']);
});

test('compatibility refresh preserves the previous generation when one API render fails', async () => {
  const db = new FakeDb();
  const failedKey = 'history:daily';
  const result = await refreshFastPagesReadModels({
    BUDDIES_DB: {},
    MINUTE_DB: db,
    OTHER_DB: {},
  }, Date.UTC(2026, 6, 16, 12), {
    render: async (variant) => {
      if (variant.key === failedKey) return Response.json({ ok: false }, { status: 500 });
      return Response.json({ ok: true, model_key: variant.key });
    },
  });

  assert.equal(result.failed, 1);
  assert.equal(result.responses.find((item) => item.key === failedKey).ok, false);
  const failedManifest = db.calls.find((call) =>
    call.method === 'run'
      && call.sql.includes('INSERT INTO sh_pages_response_manifest')
      && call.params[0] === failedKey);
  assert.equal(failedManifest, undefined);
});
