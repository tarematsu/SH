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
import {
  decodeRawCollectionTextMessage,
  textTransportQueue,
} from '../src/raw-collection-text-transport.js';
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

test('raw collection fetch stage uses text transport for the large response body', async () => {
  const sent = [];
  const queue = textTransportQueue({
    async send(body, options) { sent.push({ body, options }); },
  });
  const result = await fetchPreparedRawCollection({ RAW_COLLECTION_QUEUE: queue }, {
    message_type: RAW_COLLECTION_FETCH_MESSAGE,
    message_version: 1,
    channel_alias: 'buddies',
    request_timeout_ms: 8_000,
    auth: { authToken: 'token', deviceUid: 'device', tokenExpiresAt: 999 },
  }, {
    async fetch() {
      return new Response('{"id":10}\n{"queue":[]}', { status: 200 });
    },
  });
  assert.equal(result.payload_chars, 22);
  assert.equal(sent.length, 1);
  assert.equal(typeof sent[0].body, 'string');
  assert.deepEqual(sent[0].options, { contentType: 'text' });
  const decoded = decodeRawCollectionTextMessage(sent[0].body);
  assert.equal(decoded.message_version, 1);
  assert.equal(decoded.body, '{"id":10}\n{"queue":[]}');
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

test('live write preparation preserves source job and complete revision state', async () => {
  const sent = [];
  let sourceOptions = null;
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
        async prepareSparseLiveRevision(_env, _payload, options) {
          sourceOptions = options;
          return {
            revision_id: 77,
            staged: true,
            sparse: true,
            source_job_id: 1,
            visible_item_count: 1,
            total_item_count: 1,
            materialized_item_count: 0,
            enrichment: { channel_id: 10 },
            queue_identity: { station_id: 20 },
          };
        },
      },
      async sendStage(body) { sent.push(body); },
    },
  });
  assert.deepEqual(queued.events, ['ack']);
  assert.deepEqual(sourceOptions, { sourceJobId: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, BUDGET_LIVE_WRITE_STAGE);
  assert.equal(sent[0].prepared_revision.source_job_id, 1);
  assert.deepEqual(sent[0].prepared_revision.queue_identity, { station_id: 20 });
});

test('budget live write commit persists the fact and forwards full revision state', async () => {
  const sent = [];
  const writes = [];
  const revision = {
    revision_id: 77,
    staged: true,
    sparse: true,
    source_job_id: 1,
    visible_item_count: 1,
    total_item_count: 1,
    materialized_item_count: 0,
    enrichment: { channel_id: 10 },
    queue_identity: { station_id: 20 },
  };
  const body = {
    ...liveWriteBody(BUDGET_LIVE_WRITE_STAGE),
    prepared_revision: revision,
  };
  await processBudgetedLiveWriteMessage({ MINUTE_LIVE_DERIVE_QUEUE: {} }, body, {
    writeThrottle: { withMinuteD1WriteThrottling: (env) => env },
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
  assert.deepEqual(writes[0].prepared_revision, revision);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, 'revision-materialize');
  assert.deepEqual(sent[0].revision, revision);
});

test('live write continuations never leak into the disabled rebuild queue', async () => {
  const liveMessages = [];
  const rebuildMessages = [];
  const writes = [];
  const liveQueue = {
    async send(body, options) { liveMessages.push({ body, options }); },
  };
  const rebuildQueue = {
    async send(body, options) { rebuildMessages.push({ body, options }); },
  };
  const env = {
    MINUTE_DERIVE_QUEUE: rebuildQueue,
    MINUTE_LIVE_DERIVE_QUEUE: liveQueue,
  };
  const revision = {
    revision_id: 88,
    staged: true,
    sparse: true,
    source_job_id: 1,
    visible_item_count: 1,
    total_item_count: 1,
    materialized_item_count: 0,
  };

  await processBudgetedLiveWriteMessage(env, liveWriteBody(), {
    materializer: {
      shouldMaterializeLiveRevision() { return true; },
      async prepareSparseLiveRevision() { return revision; },
    },
  });

  assert.equal(rebuildMessages.length, 0);
  assert.equal(liveMessages.length, 1);
  assert.equal(liveMessages[0].body.stage, BUDGET_LIVE_WRITE_STAGE);

  await processBudgetedLiveWriteMessage(env, liveMessages[0].body, {
    writeThrottle: { withMinuteD1WriteThrottling: (active) => active },
    deriveQueue: {
      async processMinuteDeriveWriteStage(active, activeBody, dependencies) {
        assert.equal(active.MINUTE_DERIVE_QUEUE, liveQueue);
        await dependencies.write(active, activeBody.payload);
        return { stage: 'write' };
      },
    },
    fastStore: {
      async saveOptimizedMinuteFactWithinBudget(_active, payload) {
        writes.push(payload);
        return { saved: true };
      },
    },
  });

  assert.equal(rebuildMessages.length, 0);
  assert.equal(liveMessages.length, 2);
  assert.equal(liveMessages[1].body.stage, 'revision-materialize');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].prepared_revision, revision);
});
