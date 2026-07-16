import assert from 'node:assert/strict';
import test from 'node:test';

import { MATERIALIZED_API_VARIANTS } from '../../site/functions/lib/api-contract.js';
import {
  dueFastMaterializedVariants,
  materializedVariantDue,
  pagesPayloadRefreshPlan,
  refreshFastPagesReadModels,
  refreshTrackHistoryPagesReadModel,
  trackHistoryRefreshRanges,
} from '../src/pages-read-model-refresh.js';

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2024, 4, 1);

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

test('track history always refreshes the recent window and starts bounded backfill behind it', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const ranges = trackHistoryRefreshRanges(now);
  const currentDay = Date.UTC(2026, 6, 16);

  assert.deepEqual(ranges.recent, {
    fromTs: currentDay - 35 * DAY_MS,
    toTs: currentDay + DAY_MS,
  });
  assert.deepEqual(ranges.backfill, {
    fromTs: currentDay - 42 * DAY_MS,
    toTs: currentDay - 35 * DAY_MS,
  });
});

test('track history backfill resumes from the durable cursor', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const nextTo = Date.UTC(2025, 0, 15);
  const ranges = trackHistoryRefreshRanges(now, { next_to: nextTo });

  assert.deepEqual(ranges.backfill, {
    fromTs: nextTo - 7 * DAY_MS,
    toTs: nextTo,
  });
});

test('track history backfill clamps its final window to the archive epoch', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const ranges = trackHistoryRefreshRanges(now, { next_to: EPOCH + 3 * DAY_MS });

  assert.deepEqual(ranges.backfill, {
    fromTs: EPOCH,
    toTs: EPOCH + 3 * DAY_MS,
  });
  assert.equal(trackHistoryRefreshRanges(now, { next_to: EPOCH }).backfill, null);
});

test('summary is daily while aggregate payloads follow their own cadence', () => {
  const midnight = Date.UTC(2026, 6, 16, 0, 0);
  const fivePast = Date.UTC(2026, 6, 16, 0, 5);
  const quarterPast = Date.UTC(2026, 6, 16, 0, 15);
  const halfPast = Date.UTC(2026, 6, 16, 0, 30);
  const materialized = new Map(MATERIALIZED_API_VARIANTS.map((variant) => [variant.key, variant]));

  assert.equal(materialized.get('host-history:summary').cadence_minutes, 1440);
  assert.equal(materialized.get('track-likes').cadence_minutes, 30);
  assert.equal(materialized.get('like-ranking').cadence_minutes, 30);
  assert.equal(materializedVariantDue(materialized.get('host-history:summary'), midnight), true);
  assert.equal(materializedVariantDue(materialized.get('host-history:summary'), quarterPast), false);
  assert.equal(materializedVariantDue(materialized.get('track-likes'), halfPast), true);
  assert.equal(materializedVariantDue(materialized.get('track-likes'), quarterPast), false);
  assert.deepEqual(pagesPayloadRefreshPlan(fivePast), { daily: false, likes: false });
  assert.deepEqual(pagesPayloadRefreshPlan(quarterPast), { daily: true, likes: false });
  assert.deepEqual(pagesPayloadRefreshPlan(halfPast), { daily: true, likes: true });
});

test('midnight refresh stores every due response as generation-safe chunks', async () => {
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

  assert.equal(result.skipped, false);
  assert.equal(result.succeeded, MATERIALIZED_API_VARIANTS.length);
  assert.equal(result.failed, 0);
  assert.equal(result.responses.length, MATERIALIZED_API_VARIANTS.length);
  const manifestWrites = db.calls.filter((call) =>
    call.method === 'run' && call.sql.includes('INSERT INTO sh_pages_response_manifest'));
  const chunkWrites = db.calls.filter((call) =>
    call.method === 'run' && call.sql.includes('INSERT INTO sh_pages_response_chunks'));
  const oldGenerationDeletes = db.calls.filter((call) =>
    call.method === 'run' && call.sql.includes('generation<>'));
  assert.equal(manifestWrites.length, MATERIALIZED_API_VARIANTS.length);
  assert.equal(chunkWrites.length, MATERIALIZED_API_VARIANTS.length);
  assert.equal(oldGenerationDeletes.length, MATERIALIZED_API_VARIANTS.length);
  assert.ok(db.calls.some((call) => call.method === 'run'
    && call.sql.includes('CREATE TABLE IF NOT EXISTS sh_pages_response_manifest')));
});

test('five-minute refresh updates only the five-minute response', async () => {
  const db = new FakeDb();
  const now = Date.UTC(2026, 6, 16, 12, 5);
  const result = await refreshFastPagesReadModels({
    BUDDIES_DB: {},
    MINUTE_DB: db,
    OTHER_DB: {},
  }, now, {
    render: async (variant) => Response.json({ ok: true, model_key: variant.key }),
  });

  assert.deepEqual(result.responses.map((item) => item.key), ['minute-facts-current']);
  assert.deepEqual(result.daily, { skipped: true, reason: 'not-due' });
  assert.deepEqual(result.likes, { skipped: true, reason: 'not-due' });
  const payloadWrites = db.calls.filter((call) =>
    call.method === 'run' && call.sql.includes('INSERT INTO sh_pages_payload_read_model'));
  assert.equal(payloadWrites.length, 0);
});

test('quarter-hour refresh skips half-hour aggregate work', async () => {
  const db = new FakeDb();
  const now = Date.UTC(2026, 6, 16, 12, 15);
  const result = await refreshFastPagesReadModels({
    BUDDIES_DB: {},
    MINUTE_DB: db,
    OTHER_DB: {},
  }, now, {
    render: async (variant) => Response.json({ ok: true, model_key: variant.key }),
  });

  const keys = result.responses.map((item) => item.key);
  assert.equal(keys.includes('track-likes'), false);
  assert.equal(keys.includes('like-ranking'), false);
  assert.equal(keys.includes('host-history:summary'), false);
  assert.equal(keys.includes('minute-facts-current'), true);
  assert.equal(keys.includes('track-history'), true);
  assert.equal(result.daily.skipped, undefined);
  assert.deepEqual(result.likes, { skipped: true, reason: 'not-due' });
});

test('half-hour fast refresh defers track history to the immediate full refresh', () => {
  const now = Date.UTC(2026, 6, 16, 12, 30);
  const keys = dueFastMaterializedVariants(now).map(({ key }) => key);
  assert.equal(keys.includes('track-history'), false);
  assert.equal(keys.includes('track-likes'), true);
  assert.equal(keys.includes('like-ranking'), true);
  assert.equal(keys.includes('minute-facts-current'), true);
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

test('fast refresh preserves the previous generation when one API render fails', async () => {
  const db = new FakeDb();
  const failedKey = 'track-history';
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
