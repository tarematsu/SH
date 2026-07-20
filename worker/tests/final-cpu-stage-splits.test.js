import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUDGET_LIVE_WRITE_STAGE,
  processBudgetedLiveWriteMessage,
} from '../src/minute-live-write-budget-entry.js';
import {
  LIVE_DERIVE_QUEUE_NAME,
  processMinutePipelineBatch,
} from '../src/minute-pipeline-entry.js';
import { fetchPreparedRawCollection } from '../src/raw-collection-fetch-entry.js';
import { RAW_COLLECTION_FETCH_MESSAGE } from '../src/raw-collection-messages.js';
import { prepareRawCollectionFetch } from '../src/raw-collection-session-entry.js';
import { runRuntimeQueue } from '../src/runtime-queue.js';
import { RAW_COLLECTION_TASK_MESSAGE } from '../src/runtime-scheduled.js';

function message(body) {
  const events = [];
  return {
    body,
    events,
    ack() { events.push('ack'); },
    retry() { events.push('retry'); },
  };
}

function liveWriteBody(stage = 'write') {
  return {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage,
    job: { id: 1, channel_id: 10, minute_at: 120_000 },
    payload: {
      rebuild: false,
      snapshot: { channel_id: 10 },
      queue: { tracks: [{ position: 0, spotify_id: 'track' }] },
    },
    started_at: 100_000,
  };
}

test('raw collection session resolution dispatches a separate fetch task', async () => {
  const sent = [];
  await prepareRawCollectionFetch({ CHANNEL_ALIAS: 'buddies' }, { scheduled_at: 123 }, {
    async ensureSession() {
      return { authToken: 'token', deviceUid: 'device', tokenExpiresAt: 999 };
    },
    async send(body) { sent.push(body); },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_type, RAW_COLLECTION_FETCH_MESSAGE);
  assert.equal(sent[0].scheduled_at, 123);
  assert.equal(sent[0].auth.authToken, 'token');
});

test('raw collection fetch stage transports text without D1 session work', async () => {
  const sent = [];
  const result = await fetchPreparedRawCollection({ RAW_COLLECTION_QUEUE: {} }, {
    message_type: RAW_COLLECTION_FETCH_MESSAGE,
    message_version: 1,
    channel_alias: 'buddies',
    request_timeout_ms: 8_000,
    auth: { authToken: 'token', deviceUid: 'device', tokenExpiresAt: 999 },
  }, {
    async fetch() {
      return new Response('{"id":10}', { status: 200 });
    },
    async send(body) { sent.push(body); },
  });
  assert.equal(result.payload_chars, 9);
  assert.equal(sent[0].message_version, 1);
  assert.equal(sent[0].body, '{"id":10}');
});

test('runtime routes raw session and fetch stages as independent acknowledgements', async () => {
  const session = message({
    message_type: RAW_COLLECTION_TASK_MESSAGE,
    message_version: 1,
    scheduled_at: 123,
  });
  const fetchStage = message({
    message_type: RAW_COLLECTION_FETCH_MESSAGE,
    message_version: 1,
    channel_alias: 'buddies',
    auth: { authToken: 'token', deviceUid: 'device' },
  });
  const dispatched = [];
  await runRuntimeQueue({ messages: [session] }, { BUDDIES_DB: {} }, {}, {
    collectionDependencies: {
      async ensureSession() { return { authToken: 'token', deviceUid: 'device' }; },
      async send(body) { dispatched.push(body); },
    },
  });
  await runRuntimeQueue({ messages: [fetchStage] }, {}, {}, {
    collectionFetchDependencies: {
      async fetch() { return new Response('{}', { status: 200 }); },
      async send(body) { dispatched.push(body); },
    },
  });
  assert.deepEqual(session.events, ['ack']);
  assert.deepEqual(fetchStage.events, ['ack']);
  assert.equal(dispatched[0].message_type, RAW_COLLECTION_FETCH_MESSAGE);
  assert.equal(dispatched[1].message_type, 'stationhead-raw-channel');
});

test('live write preparation is deferred before fact persistence', async () => {
  const sent = [];
  const queued = message(liveWriteBody());
  await processMinutePipelineBatch({
    queue: LIVE_DERIVE_QUEUE_NAME,
    messages: [queued],
  }, {
    HISTORICAL_REBUILD_ENABLED: false,
    MINUTE_LIVE_DERIVE_QUEUE: {},
  }, null, {
    liveWrite: {
      materializer: {
        shouldMaterializeLiveRevision() { return true; },
        async prepareSparseLiveRevision() {
          return { revision_id: 77, staged: true, item_count: 1 };
        },
      },
      async sendStage(body) { sent.push(body); },
    },
  });
  assert.deepEqual(queued.events, ['ack']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, BUDGET_LIVE_WRITE_STAGE);
  assert.equal(sent[0].prepared_revision.revision_id, 77);
});

test('budget live write commit persists the fact and dispatches revision close separately', async () => {
  const sent = [];
  const writes = [];
  const body = {
    ...liveWriteBody(BUDGET_LIVE_WRITE_STAGE),
    prepared_revision: { revision_id: 77, staged: true, item_count: 1 },
  };
  await processBudgetedLiveWriteMessage({ MINUTE_LIVE_DERIVE_QUEUE: {} }, body, {
    appleRuntime: { withAppleMusicFreeRuntime: (env) => env },
    writeThrottle: { withMinuteD1WriteThrottle: (env) => env },
    deriveQueue: {
      async processMinuteDeriveWriteStage(env, activeBody, dependencies) {
        await dependencies.write(env, activeBody.payload);
        return { stage: 'write' };
      },
    },
    fastStore: {
      async saveOptimizedMinuteFactWithinBudget(_env, payload) {
        writes.push(payload);
        return { saved: true };
      },
    },
    async sendStage(activeBody) { sent.push(activeBody); },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].prepared_revision.revision_id, 77);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, 'revision-materialize');
});
