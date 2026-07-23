import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { processMinuteDeriveBatch } from '../src/minute-derive-entry.js';
import { consumeMinuteQueue } from '../src/minute-production-entry.js';
import {
  minuteDirectLiveDeriveMessage,
  parseDirectLiveMinuteDeriveMessage,
} from '../src/minute-derive-trigger.js';
import { materializedTrackHistorySql } from '../src/pages-track-history-r2-shards.js';

const payload = {
  payload_version: 1,
  observedAt: 180_001,
  snapshot: { channel_id: 10, listener_count: 20 },
  queue: null,
  comments: {},
  rebuild: null,
};

const migration = readFileSync(
  new URL('../../database/facts-migrations/031_observability_hotpaths.sql', import.meta.url),
  'utf8',
);
const middleware = readFileSync(
  new URL('../../site/functions/_middleware.js', import.meta.url),
  'utf8',
);
const dashboardEntry = readFileSync(
  new URL('../../site/functions/api/dashboard.js', import.meta.url),
  'utf8',
);

test('materialized Pages APIs fail closed and mask the legacy dashboard DB', () => {
  assert.match(middleware, /x-materialized-required/);
  assert.doesNotMatch(middleware, /prebuilt \|\| await context\.next\(\)/);
  assert.match(dashboardEntry, /Object\.defineProperty\(env, 'DB'/);
  assert.match(dashboardEntry, /value: null/);
});

test('track history uses incrementally materialized queue starts', () => {
  const sql = materializedTrackHistorySql();
  assert.match(sql, /FROM sh_track_history_queue_starts/);
  assert.doesNotMatch(sql, /SELECT DISTINCT station_id,start_time\s+FROM sh_queue_items/);
});

test('queue-start migration seeds and advances the latest complete revision', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sh_queue_revisions(
    id INTEGER PRIMARY KEY,
    channel_id INTEGER NOT NULL,
    station_id INTEGER,
    queue_start_time INTEGER,
    effective_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    source_job_id INTEGER,
    coverage_complete INTEGER,
    source_visible_count INTEGER,
    materialized_item_count INTEGER,
    last_materialized_at INTEGER
  );`);
  db.exec(migration);
  const start = Date.parse('2026-07-20T00:00:00Z');
  db.prepare(`INSERT INTO sh_queue_revisions(
    id,channel_id,station_id,queue_start_time,effective_at,status
  ) VALUES(1,10,20,?,?, 'complete')`).run(start, start);
  assert.equal(
    db.prepare('SELECT latest_revision_id FROM sh_track_history_queue_starts').get().latest_revision_id,
    1,
  );
  db.prepare(`INSERT INTO sh_queue_revisions(
    id,channel_id,station_id,queue_start_time,effective_at,status
  ) VALUES(2,10,20,?,?, 'complete')`).run(start, start + 1);
  assert.equal(
    db.prepare('SELECT latest_revision_id FROM sh_track_history_queue_starts').get().latest_revision_id,
    2,
  );
});

test('normal live ingest bypasses the D1 job ledger', async () => {
  let handlers;
  let inboxCalls = 0;
  const direct = [];
  const env = {
    LIVE_DERIVE_DIRECT_QUEUE_ENABLED: true,
    LIVE_REVISION_MATERIALIZATION_ENABLED: false,
  };
  await consumeMinuteQueue({ messages: [] }, env, null, {
    consumeMinuteFactBatch: async (_batch, _env, value) => {
      handlers = value;
      return { received: 0 };
    },
    enqueueMinuteFactJob: async () => {
      inboxCalls += 1;
      throw new Error('D1 inbox must not be used');
    },
    enqueueDirectLiveMinuteDerive: async (_env, value) => {
      direct.push(value);
      return { enqueued: true, direct: true };
    },
  });
  const result = await handlers.enqueue(env, payload, { jobKind: 'live' });
  assert.deepEqual(result, { enqueued: true, direct: true });
  assert.equal(inboxCalls, 0);
  assert.deepEqual(direct, [payload]);
});

test('normal live ingest can finish inside the buddies-facts consumer', async () => {
  let handlers;
  let directCalls = 0;
  const writes = [];
  const enrichmentQueue = { send() { throw new Error('enrichment Queue must be bypassed'); } };
  const env = {
    LIVE_DERIVE_INLINE_ENABLED: true,
    LIVE_DERIVE_DIRECT_QUEUE_ENABLED: true,
    LIVE_REVISION_MATERIALIZATION_ENABLED: false,
    MINUTE_ENRICHMENT_QUEUE: enrichmentQueue,
  };
  await consumeMinuteQueue({ messages: [] }, env, null, {
    consumeMinuteFactBatch: async (_batch, _env, value) => {
      handlers = value;
      return { received: 0 };
    },
    enqueueMinuteFactJob: async () => {
      throw new Error('D1 inbox must not be used');
    },
    enqueueDirectLiveMinuteDerive: async () => {
      directCalls += 1;
      throw new Error('live derive Queue must not be used');
    },
    saveOptimizedMinuteFactWithinBudget: async (activeEnv, value) => {
      assert.equal(activeEnv.MINUTE_ENRICHMENT_QUEUE, null);
      writes.push(value);
      return { skipped: false };
    },
  });

  const result = await handlers.enqueue(env, payload, { jobKind: 'live' });

  assert.deepEqual(result, {
    enqueued: true,
    direct: true,
    inline: true,
    channel_id: 10,
    minute_at: 180_000,
    job_kind: 'live',
    job_priority: 100,
  });
  assert.equal(directCalls, 0);
  assert.deepEqual(writes, [payload]);
  assert.strictEqual(env.MINUTE_ENRICHMENT_QUEUE, enrichmentQueue);
});

test('direct live Queue payload writes without claim or completion lifecycle calls', async () => {
  const body = minuteDirectLiveDeriveMessage(payload);
  assert.equal(parseDirectLiveMinuteDeriveMessage(body).payload, payload);
  const writes = [];
  let acked = 0;
  let retried = 0;
  await processMinuteDeriveBatch({
    queue: 'stationhead-minute-live-derive',
    messages: [{
      body,
      ack() { acked += 1; },
      retry() { retried += 1; },
    }],
  }, {}, {
    writeDirectLive: async (_env, value) => writes.push(value),
  });
  assert.deepEqual(writes, [payload]);
  assert.equal(acked, 1);
  assert.equal(retried, 0);
});
