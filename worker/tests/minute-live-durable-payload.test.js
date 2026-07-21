import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUDGET_LIVE_WRITE_STAGE,
  processBudgetedLiveWriteMessage,
} from '../src/minute-live-write-budget-entry.js';
import { processBudgetedLiveTriggerMessage } from '../src/minute-live-trigger-budget-entry.js';
import { budgetedLiveTriggerBatch } from '../src/minute-pipeline-entry.js';

function trigger() {
  return {
    message_type: 'minute-fact-derive',
    message_version: 1,
    job_id: 'minute-fact:10:120000',
    channel_id: 10,
    minute_at: 120_000,
    job_kind: 'live',
  };
}

function job() {
  return {
    id: 7,
    channel_id: 10,
    minute_at: 120_000,
    payload_version: 1,
    job_kind: 'live',
    attempts: 1,
    payload_json: 'x'.repeat(44_000),
  };
}

function payload() {
  return {
    payload_version: 1,
    observedAt: 125_000,
    snapshot: {
      channel_id: 10,
      station_id: 20,
      is_broadcasting: 1,
    },
    queue: {
      station_id: 20,
      queue_id: 30,
      start_time: 60_000,
      total_track_count: 1,
      tracks: [{ position: 0, duration_ms: 180_000 }],
    },
    rebuild: null,
  };
}

function writeStage(stage = 'write') {
  return {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage,
    job: job(),
    started_at: 124_000,
    durable_payload: true,
  };
}

test('budgeted live triggers enqueue only durable job identity', async () => {
  let sent = null;
  const result = await processBudgetedLiveTriggerMessage({}, trigger(), {
    now: () => 124_000,
    claim: async () => job(),
    sendStage: async (message) => { sent = message; },
  });

  assert.equal(result.pending, true);
  assert.equal(sent.stage, 'write');
  assert.equal(sent.job.id, 7);
  assert.equal(sent.durable_payload, true);
  assert.equal(Object.hasOwn(sent, 'payload'), false);
  assert.ok(JSON.stringify(sent).length < 500);
});

test('compact live triggers are selected when revision materialization is disabled', () => {
  assert.equal(budgetedLiveTriggerBatch({ messages: [{ body: trigger() }] }, {
    HISTORICAL_REBUILD_ENABLED: false,
  }), true);
});

test('live revision preparation reloads payload and keeps the continuation compact', async () => {
  let sent = null;
  const result = await processBudgetedLiveWriteMessage({
    DERIVE_REVISION_STAGE_TRACKS: 1,
  }, writeStage(), {
    loadPayload: async () => payload(),
    materializer: {
      shouldMaterializeLiveRevision: () => true,
      prepareSparseLiveRevision: async () => ({
        sparse: true,
        staged: true,
        revision_id: 40,
      }),
    },
    sendStage: async (message) => { sent = message; },
  });

  assert.equal(result.revision_id, 40);
  assert.equal(sent.stage, BUDGET_LIVE_WRITE_STAGE);
  assert.equal(sent.prepared_revision.revision_id, 40);
  assert.equal(sent.durable_payload, true);
  assert.equal(Object.hasOwn(sent, 'payload'), false);
});

test('live writes without a revision still cross a separate CPU boundary', async () => {
  let sent = null;
  await processBudgetedLiveWriteMessage({}, writeStage(), {
    loadPayload: async () => ({ ...payload(), queue: null }),
    materializer: {
      shouldMaterializeLiveRevision: () => false,
    },
    sendStage: async (message) => { sent = message; },
  });

  assert.equal(sent.stage, BUDGET_LIVE_WRITE_STAGE);
  assert.equal(Object.hasOwn(sent, 'payload'), false);
});

test('live write commit reloads payload locally and never forwards it', async () => {
  let saved = null;
  let followup = null;
  const prepared = { sparse: true, staged: true, revision_id: 40 };
  const result = await processBudgetedLiveWriteMessage({}, {
    ...writeStage(BUDGET_LIVE_WRITE_STAGE),
    prepared_revision: prepared,
  }, {
    loadPayload: async () => payload(),
    appleRuntime: { withAppleMusicFreeRuntime: (env) => env },
    writeThrottle: { withMinuteD1WriteThrottling: (env) => env },
    deriveQueue: {
      processMinuteDeriveWriteStage: async (env, body, dependencies) => {
        assert.equal(body.payload.snapshot.channel_id, 10);
        await dependencies.write(env, body.payload);
        return { pending: true };
      },
    },
    fastStore: {
      saveOptimizedMinuteFactWithinBudget: async (_env, value) => { saved = value; },
    },
    sendStage: async (message) => { followup = message; },
  });

  assert.equal(result.pending, true);
  assert.equal(saved.prepared_revision.revision_id, 40);
  assert.equal(followup.stage, 'revision-materialize');
  assert.equal(Object.hasOwn(followup, 'payload'), false);
});
