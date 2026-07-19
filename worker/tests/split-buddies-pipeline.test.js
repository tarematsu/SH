import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  channelFromRawCollection,
  collectionFromRawCollection,
  commentsTaskForMinuteFact,
  readModelEnvelopeForMinuteFact,
} from '../src/ingest-channel-entry.js';
import { preparedCollectionPayload } from '../src/collector-runner.js';
import { minuteFactQueueMessage } from '../src/minute-facts-queue.js';
import { collectRawChannel } from '../src/raw-collector-entry.js';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

function commentsTask() {
  return {
    message_type: 'stationhead-comments-task',
    message_version: 1,
    observed_at: 1_784_000_012_345,
    station_id: 123,
    auth: {
      authToken: 'token',
      deviceUid: 'device',
      tokenExpiresAt: 9_999_999_999_999,
    },
  };
}

test('ordered queues retain one owner after buddies collection consolidation', () => {
  const monitor = config('wrangler.jsonc');
  const ingest = config('wrangler.ingest.jsonc');
  const comments = config('wrangler.comments.jsonc');
  const readModel = config('wrangler.pages-read-model.jsonc');
  const minuteIngest = config('wrangler.minute-ingest.jsonc');
  const minuteDerive = config('wrangler.minute-derive.jsonc');
  const minuteMaintenance = config('wrangler.minute.jsonc');

  assert.equal(monitor.name, 'sh-monitor-other');
  assert.equal(monitor.main, 'src/other-entry.js');
  assert.equal(ingest.main, 'src/ingest-channel-optimized-entry.js');
  assert.equal(comments.main, 'src/comments-cpu-entry.js');
  assert.equal(readModel.main, 'src/pages-read-model-entry.js');
  assert.equal(minuteIngest.main, 'src/minute-production-entry.js');
  assert.equal(minuteDerive.main, 'src/minute-derive-entry.js');
  assert.equal(minuteMaintenance.main, 'src/minute-maintenance-entry.js');

  assert.equal(
    monitor.queues.producers.find(({ binding }) => binding === 'RAW_COLLECTION_QUEUE').queue,
    'stationhead-raw-collection',
  );
  assert.equal(ingest.queues.consumers[0].queue, 'stationhead-raw-collection');
  assert.equal(ingest.queues.producers.some(({ binding }) => binding === 'MINUTE_FACT_QUEUE'), false);
  assert.equal(ingest.queues.producers.find(({ binding }) => binding === 'COMMENTS_QUEUE').queue, 'stationhead-comments');
  assert.equal(comments.queues.consumers[0].queue, 'stationhead-comments');
  assert.equal(comments.queues.producers.find(({ binding }) => binding === 'MINUTE_FACT_QUEUE').queue, 'stationhead-buddies-facts');
  assert.equal(ingest.queues.producers.find(({ binding }) => binding === 'READ_MODEL_QUEUE').queue, 'stationhead-read-model');
  assert.equal(readModel.queues.consumers.find(({ queue }) => queue === 'stationhead-read-model').queue, 'stationhead-read-model');
  assert.equal(minuteIngest.queues.consumers[0].queue, 'stationhead-buddies-facts');
  assert.equal(minuteIngest.queues.consumers[0].max_batch_size, 1);
  assert.equal(minuteDerive.queues.consumers[0].queue, 'stationhead-minute-derive');
  assert.equal(minuteDerive.queues.consumers[0].max_batch_size, 1);
  assert.equal(minuteMaintenance.queues.consumers, undefined);
});

test('raw collector emits a compact prepared v3 message for the normal channel shape', async () => {
  const sent = [];
  const body = JSON.stringify({
    id: 10,
    alias: 'buddies',
    current_station_id: 123,
    current_station: {
      id: 123,
      queue: {
        id: 456,
        start_time: 1_784_000_000_000,
        is_paused: false,
        queue_tracks: [{
          id: 11,
          track: {
            id: 22,
            spotify_id: 'track',
            bite_count: 4,
            title: 'Song',
            artist: { name: 'Artist' },
          },
        }],
      },
    },
  });
  const env = {
    CHANNEL_ALIAS: 'buddies',
    REQUEST_TIMEOUT_MS: 8_000,
    RAW_COLLECTION_QUEUE: {
      async send(message) { sent.push(message); },
    },
  };
  await collectRawChannel(env, {
    ensureSession: async () => ({
      authToken: 'token',
      deviceUid: 'device',
      tokenExpiresAt: 9_999_999_999_999,
    }),
    fetch: async () => new Response(body, { status: 200 }),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_type, 'stationhead-raw-channel');
  assert.equal(sent[0].message_version, 3);
  assert.equal(sent[0].channel_alias, 'buddies');
  assert.equal(sent[0].snapshot.channel_id, 10);
  assert.equal(sent[0].snapshot.station_id, 123);
  assert.equal(sent[0].queue.queue_id, 456);
  assert.equal(sent[0].queue.tracks[0].spotify_id, 'track');
  assert.equal(Object.hasOwn(sent[0], 'channel'), false);
  assert.equal(Object.hasOwn(sent[0], 'body'), false);
});

test('raw collector retains v2 validation retries for unexpected valid objects', async () => {
  const sent = [];
  const body = '{"id":10,"alias":"unexpected","current_station_id":123}';
  await collectRawChannel({
    CHANNEL_ALIAS: 'buddies',
    REQUEST_TIMEOUT_MS: 8_000,
    RAW_COLLECTION_QUEUE: {
      async send(message) { sent.push(message); },
    },
  }, {
    ensureSession: async () => ({ authToken: 'token', deviceUid: 'device', tokenExpiresAt: 9_999_999_999_999 }),
    fetch: async () => new Response(body, { status: 200 }),
  });

  assert.equal(sent[0].message_version, 2);
  assert.deepEqual(sent[0].channel, JSON.parse(body));
  assert.equal(Object.hasOwn(sent[0], 'snapshot'), false);
});

test('raw collector retains the legacy v1 poison path for malformed JSON', async () => {
  const sent = [];
  const body = '{"id":10';
  await collectRawChannel({
    CHANNEL_ALIAS: 'buddies',
    REQUEST_TIMEOUT_MS: 8_000,
    RAW_COLLECTION_QUEUE: {
      async send(message) { sent.push(message); },
    },
  }, {
    ensureSession: async () => ({ authToken: 'token', deviceUid: 'device', tokenExpiresAt: 9_999_999_999_999 }),
    fetch: async () => new Response(body, { status: 200 }),
  });

  assert.equal(sent[0].message_version, 1);
  assert.equal(sent[0].body, body);
  assert.equal(Object.hasOwn(sent[0], 'channel'), false);
});

test('ingest accepts compact v3 payloads and remains compatible with v1 and v2', () => {
  const channel = { id: 10, alias: 'buddies', current_station_id: 123 };
  assert.equal(channelFromRawCollection({
    message_type: 'stationhead-raw-channel',
    message_version: 2,
    channel,
  }), channel);
  assert.deepEqual(channelFromRawCollection({
    message_type: 'stationhead-raw-channel',
    message_version: 1,
    body: JSON.stringify(channel),
  }), channel);

  const snapshot = { channel_id: 10, channel_alias: 'buddies', station_id: 123 };
  const queue = { station_id: 123, tracks: [] };
  const prepared = collectionFromRawCollection({
    message_type: 'stationhead-raw-channel',
    message_version: 3,
    channel_alias: 'buddies',
    snapshot,
    queue,
  });
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.snapshot, snapshot);
  assert.equal(prepared.queue, queue);
  assert.throws(() => collectionFromRawCollection({
    message_type: 'stationhead-raw-channel',
    message_version: 3,
    channel_alias: 'buddies',
    snapshot,
    queue: { station_id: 999, tracks: [] },
  }), /station identity does not match/);
});

test('prepared collector payload preserves compact object identity and planning', () => {
  const snapshot = { channel_id: 10, station_id: 123 };
  const queue = { station_id: 123, tracks: [] };
  const state = { channelId: null, stationId: null };
  const result = preparedCollectionPayload(
    { snapshot, queue },
    state,
    { metadataRefreshIntervalMs: 15 * 60_000 },
    1_784_000_000_000,
    1_784_000_060_000,
    false,
  );
  assert.equal(result.snapshot, snapshot);
  assert.equal(result.queue, queue);
  assert.equal(state.channelId, 10);
  assert.equal(state.stationId, 123);
  assert.equal(result.initialPlan.snapshot, true);
  assert.equal(result.initialPlan.queue, true);
});

test('outbox retries retain durable minute timestamp and read-model identity', () => {
  const processingObservedAt = commentsTask().observed_at;
  const queue = {
    station_id: 123,
    queue_id: 456,
    start_time: processingObservedAt - 60_000,
    is_paused: false,
    tracks: [{ position: 0, spotify_id: 'track', title: 'Song', artist: 'Artist' }],
  };
  const minuteFact = minuteFactQueueMessage({
    observedAt: processingObservedAt,
    snapshot: { channel_id: 10, station_id: 123, listener_count: 99 },
    queue,
  }, {
    readModelPresentationOnly: true,
    readModel: {
      channel: { channel_id: 10, observed_at: processingObservedAt, presentation: { description: 'kept' } },
      queue: { station_id: 123, queue_id: 456, start_time: queue.start_time, is_paused: false, value: queue },
      collector: {
        collector_id: 'cloudflare-worker',
        last_run_at: processingObservedAt,
        last_success_at: processingObservedAt,
        last_error_present: false,
        updated_at: processingObservedAt,
      },
    },
  });
  const task = commentsTaskForMinuteFact(commentsTask(), minuteFact);
  const envelope = readModelEnvelopeForMinuteFact(commentsTask(), minuteFact);

  assert.equal(task.observed_at, processingObservedAt);
  assert.equal(task.station_id, 123);
  assert.equal(envelope.observed_at, processingObservedAt);
  assert.equal(envelope.job_id, `read-model:10:${processingObservedAt}`);
  assert.equal(envelope.read_model.queue.value, queue);
  assert.equal(envelope.comment_task.station_id, 123);
});
