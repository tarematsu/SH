import assert from 'node:assert/strict';
import test from 'node:test';

import { MATERIALIZED_API_VARIANTS } from '../../site/functions/lib/api-contract.js';
import {
  materializedVariantDue,
  refreshFastPagesReadModels,
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

test('current APIs render on demand while historical variants refresh every fifteen minutes', () => {
  const fivePast = Date.UTC(2026, 6, 16, 12, 5);
  const fifteenPast = Date.UTC(2026, 6, 16, 12, 15);
  const materializedKeys = new Set(MATERIALIZED_API_VARIANTS.map((variant) => variant.key));

  assert.equal(materializedKeys.has('dashboard'), false);
  assert.equal(materializedKeys.has('dashboard-queue'), false);
  assert.equal(materializedKeys.has('comment-velocity'), false);
  assert.equal([...materializedKeys].some((key) => key.startsWith('playback:')), false);
  assert.equal(materializedKeys.has('track-history'), true);
  assert.equal(materializedKeys.has('history:weekly'), true);
  assert.deepEqual(
    MATERIALIZED_API_VARIANTS.filter((variant) => materializedVariantDue(variant, fivePast)).map((variant) => variant.key),
    ['minute-facts-current'],
  );
  assert.equal(MATERIALIZED_API_VARIANTS.every((variant) => materializedVariantDue(variant, fifteenPast)), true);
});

test('hourly refresh stores all completed default API responses as generation-safe chunks', async () => {
  const db = new FakeDb();
  const env = { BUDDIES_DB: {}, MINUTE_DB: db, OTHER_DB: {} };
  const now = Date.UTC(2026, 6, 16, 12);
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

test('five-minute refresh renders only the current minute-facts variant', async () => {
  const db = new FakeDb();
  const now = Date.UTC(2026, 6, 16, 12, 5);
  const result = await refreshFastPagesReadModels({
    BUDDIES_DB: {},
    MINUTE_DB: db,
    OTHER_DB: {},
  }, now, {
    render: async (variant) => Response.json({ ok: true, model_key: variant.key }),
  });

  assert.equal(result.deferred, MATERIALIZED_API_VARIANTS.length - 1);
  assert.equal(result.responses.some((item) => item.key.startsWith('playback:')), false);
  assert.equal(result.responses.some((item) => item.key === 'dashboard'), false);
  assert.equal(result.responses.some((item) => item.key === 'dashboard-queue'), false);
  assert.equal(result.responses.some((item) => item.key === 'comment-velocity'), false);
  assert.deepEqual(result.responses.map((item) => item.key), ['minute-facts-current']);
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
