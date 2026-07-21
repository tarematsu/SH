import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { processMinuteRebuildStage } from '../src/minute-rebuild-entry.js';

const env = { BUDDIES_DB: {}, MINUTE_DB: {} };
const base = {
  message_type: 'minute-rebuild-stage',
  message_version: 1,
  run_id: 'minute-rebuild:123',
  scheduled_at: 123,
};

function harness() {
  const enqueued = [];
  const recorded = [];
  return {
    enqueued,
    recorded,
    dependencies: {
      async enqueueStage(_env, task, stage, delaySeconds = 0, details = null) {
        enqueued.push({ runId: task.runId, stage, delaySeconds, details });
      },
      async recordStage(_env, task, result, _startedAt, success = true) {
        recorded.push({ stage: task.stage, result, success });
      },
    },
  };
}

test('rebuild scan defers candidate preparation without recording a partial logical run', async () => {
  const h = harness();
  const result = await processMinuteRebuildStage(env, { ...base, stage: 'backfill' }, {
    ...h.dependencies,
    scanBackfill: async (active) => {
      assert.equal(active.DB, env.BUDDIES_DB);
      return { scanned_snapshots: 1, pending_candidates: 1 };
    },
  });

  assert.equal(result.pending, true);
  assert.deepEqual(h.enqueued, [{
    runId: base.run_id,
    stage: 'backfill-prepare',
    delaySeconds: 0,
    details: null,
  }]);
  assert.deepEqual(h.recorded, []);
});

test('rebuild preparation transports one compact candidate to a commit invocation', async () => {
  const h = harness();
  const prepared = {
    candidate: {
      minuteAt: 120_000,
      observedAt: 125_000,
      snapshot: { channel_id: 10, station_id: 20 },
      rebuild: { mode: 'exact' },
    },
    queue: null,
    comments: { commentCount: 1, commentTotal: null, degraded: false },
    skip_existing: false,
  };
  const result = await processMinuteRebuildStage(env, { ...base, stage: 'backfill-prepare' }, {
    ...h.dependencies,
    prepareBackfill: async () => ({ prepared, pending_candidates: 1 }),
  });

  assert.equal(result.pending, true);
  assert.equal(h.enqueued.length, 1);
  assert.equal(h.enqueued[0].stage, 'backfill-commit');
  assert.equal(h.enqueued[0].details.prepared, prepared);
  assert.deepEqual(h.recorded, []);
});

test('rebuild commit stops after draining the prepared source batch', async () => {
  const h = harness();
  const prepared = {
    candidate: {
      minuteAt: 120_000,
      observedAt: 125_000,
      snapshot: { channel_id: 10, station_id: 20 },
      rebuild: { mode: 'exact' },
    },
  };
  const result = await processMinuteRebuildStage(env, {
    ...base,
    stage: 'backfill-commit',
    prepared,
  }, {
    ...h.dependencies,
    commitBackfill: async (_active, value) => {
      assert.equal(value, prepared);
      return { enqueued: 1, pending_candidates: 0 };
    },
  });

  assert.equal(result.pending, false);
  assert.equal(result.result.processed_jobs, 1);
  assert.equal(result.result.paused_for_budget, false);
  assert.deepEqual(h.recorded.map((item) => item.stage), ['backfill']);
  assert.deepEqual(h.enqueued, []);
});

test('rebuild commit spaces the next pending candidate across the hourly budget', async () => {
  const h = harness();
  const result = await processMinuteRebuildStage(env, {
    ...base,
    stage: 'backfill-commit',
    prepared: { candidate: { snapshot: { channel_id: 10 }, minuteAt: 120_000 } },
  }, {
    ...h.dependencies,
    commitBackfill: async () => ({ enqueued: 1, pending_candidates: 2 }),
  });

  assert.equal(result.pending, true);
  assert.equal(result.result.processed_jobs, 1);
  assert.equal(result.result.paused_for_budget, false);
  assert.deepEqual(h.enqueued, [{
    runId: base.run_id,
    stage: 'backfill-prepare',
    delaySeconds: 900,
    details: { processed_jobs: 1 },
  }]);
});

test('rebuild commit pauses durable pending work at the configured per-run limit', async () => {
  const h = harness();
  const result = await processMinuteRebuildStage({
    ...env,
    REBUILD_MAX_JOBS: 2,
  }, {
    ...base,
    stage: 'backfill-commit',
    processed_jobs: 1,
    prepared: { candidate: { snapshot: { channel_id: 10 }, minuteAt: 120_000 } },
  }, {
    ...h.dependencies,
    commitBackfill: async () => ({ enqueued: 1, pending_candidates: 2 }),
  });

  assert.equal(result.pending, true);
  assert.equal(result.result.processed_jobs, 2);
  assert.equal(result.result.max_jobs, 2);
  assert.equal(result.result.paused_for_budget, true);
  assert.deepEqual(h.enqueued, []);
});

test('durable rebuild commit dispatches one derive trigger without batching fact work', async () => {
  const h = harness();
  const sent = [];
  const prepared = {
    candidate: {
      minuteAt: 120_000,
      observedAt: 125_000,
      snapshot: { channel_id: 10, station_id: 20 },
      rebuild: { mode: 'exact' },
    },
    skip_existing: false,
  };
  const result = await processMinuteRebuildStage({
    ...env,
    MINUTE_DERIVE_QUEUE: {
      async send(body, options) { sent.push({ body, options }); },
    },
  }, {
    ...base,
    stage: 'backfill-commit',
    prepared,
  }, {
    ...h.dependencies,
    commitBackfill: async () => ({ enqueued: 1, pending_candidates: 0 }),
  });

  assert.equal(result.result.derive_dispatched, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    body: {
      message_type: 'minute-fact-derive',
      message_version: 1,
      job_id: 'minute-fact:10:120000',
      channel_id: 10,
      minute_at: 120_000,
    },
    options: { contentType: 'json' },
  });
});

test('gap commit dispatches at most the first prepared candidate per invocation', async () => {
  const h = harness();
  const sent = [];
  const prepared = {
    attempted: [
      { minuteAt: 60_000, snapshot: { channel_id: 10 } },
      { minuteAt: 120_000, snapshot: { channel_id: 10 } },
    ],
  };
  const result = await processMinuteRebuildStage({
    ...env,
    MINUTE_DERIVE_QUEUE: {
      async send(body) { sent.push(body); },
    },
  }, {
    ...base,
    stage: 'gap-commit',
    prepared,
  }, {
    ...h.dependencies,
    commitGapScan: async () => ({ event: 'minute_fact_gap_scan_summary', enqueued: 2 }),
  });

  assert.equal(result.result.derive_dispatched, true);
  assert.deepEqual(sent.map((body) => body.minute_at), [60_000]);
});

test('thirty-day reconstruction stays enabled with D1-budgeted recovery throughput', () => {
  const runtime = JSON.parse(readFileSync(new URL('../wrangler.runtime.jsonc', import.meta.url), 'utf8'));
  const entry = readFileSync(new URL('../src/minute-rebuild-entry.js', import.meta.url), 'utf8');
  const rebuild = runtime.queues.consumers.find(({ queue }) => queue === 'stationhead-minute-rebuild');

  assert.equal(runtime.vars.HISTORICAL_REBUILD_ENABLED, true);
  assert.equal(runtime.vars.REBUILD_HISTORICAL_BACKFILL_ENABLED, true);
  assert.equal(runtime.vars.REBUILD_HISTORICAL_BACKFILL_INTERVAL_MS, 3_600_000);
  assert.equal(runtime.vars.DERIVE_DISPATCH_LIMIT, 2);
  assert.equal(runtime.vars.DERIVE_REVISION_RECOVERY_LIMIT, 1);
  assert.equal(runtime.vars.REBUILD_SOURCE_ROWS, 20);
  assert.equal(runtime.vars.REBUILD_MAX_JOBS, 4);
  assert.equal(runtime.vars.GAP_SCAN_WINDOW_MINUTES, 1440);
  assert.equal(runtime.vars.GAP_SCAN_MAX_JOBS, 4);
  assert.match(entry, /DEFAULT_REBUILD_STAGE_INTERVAL_SECONDS = 15 \* 60/);
  assert.match(entry, /processed_jobs/);
  assert.equal(rebuild.max_batch_size, 1);
  assert.equal(rebuild.max_concurrency, 1);
  assert.equal(
    runtime.queues.producers.some(({ binding }) => binding === 'MINUTE_DERIVE_QUEUE'),
    true,
  );
});
