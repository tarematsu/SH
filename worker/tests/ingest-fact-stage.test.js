import assert from 'node:assert/strict';
import test from 'node:test';

import {
  processIngestFactDeliveryTask,
  processIngestFactTask,
} from '../src/ingest-fact-stage.js';
import { minuteFactQueueMessage } from '../src/minute-facts-queue.js';

const observedAt = 1_784_000_000_000;

test('isolated ingest fact stage preserves comments and finalize ordering', async () => {
  const comments = [];
  const finalized = [];
  const fact = {
    observedAt,
    snapshot: { channel_id: 10, station_id: 20 },
    queue: { station_id: 20, tracks: [] },
    comments: { commentsSaved: 0, degraded: false },
    auth: { authToken: 'token', deviceUid: 'device' },
    collectorState: {
      authToken: 'token',
      deviceUid: 'device',
      lastRunAt: observedAt,
      lastSuccessAt: observedAt + 1,
    },
    options: {
      collectComments: false,
      readModelPresentationOnly: true,
      readModel: {
        channel: { channel_id: 10, observed_at: observedAt, presentation: {} },
        queue: { station_id: 20 },
        collector: { collector_id: 'cloudflare-worker', updated_at: observedAt },
      },
    },
  };
  const result = await processIngestFactTask({
    DB: {},
    COMMENTS_QUEUE: { async send(body) { comments.push(body); } },
  }, {
    message_type: 'stationhead-ingest-fact',
    message_version: 1,
    fact,
  }, {
    async handoffMinuteFactJob(activeEnv, input, options) {
      const body = minuteFactQueueMessage(input, options);
      await activeEnv.MINUTE_FACT_QUEUE.send(body, { contentType: 'json' });
      return { enqueued: true, outbox_pending: false, minute_at: body.minute_at };
    },
    async sendFinalize(body) { finalized.push(body); },
  });

  assert.equal(comments.length, 1);
  assert.equal(comments[0].message_type, 'stationhead-comments-task');
  assert.equal(comments[0].minute_fact.read_model, null);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].message_type, 'stationhead-ingest-finalize');
  assert.equal(finalized[0].read_model.message_type, 'stationhead-read-model');
  assert.equal(result.event, 'ingest_fact_completed');
});


test('production ingest fact stage persists the outbox before deferring delivery', async () => {
  const delivered = [];
  const comments = [];
  const fact = {
    observedAt,
    snapshot: { channel_id: 10, station_id: 20 },
    queue: { station_id: 20, tracks: [] },
    comments: { commentsSaved: 0, degraded: false },
    auth: { authToken: 'token', deviceUid: 'device' },
    collectorState: {
      authToken: 'token',
      deviceUid: 'device',
      lastRunAt: observedAt,
      lastSuccessAt: observedAt + 1,
    },
    options: {
      collectComments: false,
      readModelPresentationOnly: true,
      readModel: {
        channel: { channel_id: 10, observed_at: observedAt, presentation: {} },
        queue: { station_id: 20 },
        collector: { collector_id: 'cloudflare-worker', updated_at: observedAt },
      },
    },
  };
  const minuteFact = minuteFactQueueMessage({
    observedAt,
    snapshot: fact.snapshot,
    queue: fact.queue,
    comments: fact.comments,
  }, fact.options);
  const result = await processIngestFactTask({
    DB: {},
    COMMENTS_QUEUE: { async send(body) { comments.push(body); } },
    INGEST_FINALIZE_QUEUE: { async send(body) { delivered.push(body); } },
  }, {
    message_type: 'stationhead-ingest-fact',
    message_version: 1,
    fact,
  }, {
    stageMinuteFactOutboxJob: async () => ({
      message: minuteFact,
      minute_at: minuteFact.minute_at,
      outbox_pending: true,
    }),
  });

  assert.equal(result.event, 'ingest_fact_staged');
  assert.equal(result.delivery_deferred, true);
  assert.equal(comments.length, 0);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message_type, 'stationhead-ingest-fact-deliver');
  assert.equal(delivered[0].minute_fact, minuteFact);
  assert.equal(delivered[0].collector_state, fact.collectorState);
});

test('deferred ingest delivery preserves outbox ordering before comments and finalization', async () => {
  const comments = [];
  const finalized = [];
  const fact = {
    observedAt,
    snapshot: { channel_id: 10, station_id: 20 },
    queue: { station_id: 20, tracks: [] },
    comments: { commentsSaved: 0, degraded: false },
    auth: { authToken: 'token', deviceUid: 'device' },
    collectorState: {
      authToken: 'token',
      deviceUid: 'device',
      lastRunAt: observedAt,
      lastSuccessAt: observedAt + 1,
    },
    options: {
      collectComments: false,
      readModelPresentationOnly: true,
      readModel: {
        channel: { channel_id: 10, observed_at: observedAt, presentation: {} },
        queue: { station_id: 20 },
        collector: { collector_id: 'cloudflare-worker', updated_at: observedAt },
      },
    },
  };
  const minuteFact = minuteFactQueueMessage({
    observedAt,
    snapshot: fact.snapshot,
    queue: fact.queue,
    comments: fact.comments,
  }, fact.options);
  const body = {
    message_type: 'stationhead-ingest-fact-deliver',
    message_version: 1,
    observed_at: observedAt,
    channel_id: 10,
    station_id: 20,
    auth: fact.auth,
    collector_state: fact.collectorState,
    minute_fact: minuteFact,
  };
  const result = await processIngestFactDeliveryTask({
    COMMENTS_QUEUE: { async send(value) { comments.push(value); } },
  }, body, {
    async flushMinuteFactOutbox(activeEnv, options) {
      assert.equal(options.limit, 1);
      await activeEnv.MINUTE_FACT_QUEUE.send(options.currentMessage, { contentType: 'json' });
      return { current_sent: true, pending: false, failed: 0 };
    },
    async sendFinalize(value) { finalized.push(value); },
  });

  assert.equal(result.event, 'ingest_fact_completed');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].message_type, 'stationhead-comments-task');
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].message_type, 'stationhead-ingest-finalize');
});

test('deferred ingest delivery retries while an older outbox job owns the head', async () => {
  const minuteFact = minuteFactQueueMessage({
    observedAt,
    snapshot: { channel_id: 10, station_id: 20 },
    queue: { station_id: 20, tracks: [] },
  }, {
    readModel: {
      channel: { channel_id: 10, presentation: {} },
      queue: { station_id: 20 },
      collector: {},
    },
  });
  await assert.rejects(
    processIngestFactDeliveryTask({}, {
      message_type: 'stationhead-ingest-fact-deliver',
      message_version: 1,
      observed_at: observedAt,
      channel_id: 10,
      collector_state: { lastRunAt: observedAt },
      minute_fact: minuteFact,
    }, {
      flushMinuteFactOutbox: async () => ({ current_sent: false, pending: true, failed: 0 }),
    }),
    (error) => error.code === 'MINUTE_FACT_DELIVERY_PENDING' && error.retryDelaySeconds === 1,
  );
});
