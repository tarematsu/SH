import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { processCommentsTask } from '../src/comments-entry.js';
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
    observed_at: 1_784_000_000_000,
    station_id: 123,
    auth: {
      authToken: 'token',
      deviceUid: 'device',
      tokenExpiresAt: 9_999_999_999_999,
    },
  };
}

test('ordered comments and three minute Workers have one owner per queue boundary', () => {
  const buddies = config('wrangler.jsonc');
  const ingest = config('wrangler.ingest.jsonc');
  const comments = config('wrangler.comments.jsonc');
  const readModel = config('wrangler.read-model.jsonc');
  const minuteIngest = config('wrangler.minute-ingest.jsonc');
  const minuteDerive = config('wrangler.minute-derive.jsonc');
  const minuteMaintenance = config('wrangler.minute.jsonc');

  assert.equal(buddies.main, 'src/raw-collector-entry.js');
  assert.equal(ingest.main, 'src/ingest-channel-entry.js');
  assert.equal(comments.main, 'src/comments-entry.js');
  assert.equal(readModel.main, 'src/read-model-entry.js');
  assert.equal(minuteIngest.main, 'src/minute-production-entry.js');
  assert.equal(minuteDerive.main, 'src/minute-derive-entry.js');
  assert.equal(minuteMaintenance.main, 'src/minute-maintenance-entry.js');

  assert.equal(buddies.queues.producers[0].queue, 'stationhead-raw-collection');
  assert.equal(ingest.queues.consumers[0].queue, 'stationhead-raw-collection');
  assert.equal(ingest.queues.producers.some(({ binding }) => binding === 'MINUTE_FACT_QUEUE'), false);
  assert.equal(ingest.queues.producers.find(({ binding }) => binding === 'COMMENTS_QUEUE').queue, 'stationhead-comments');
  assert.equal(comments.queues.consumers[0].queue, 'stationhead-comments');
  assert.equal(comments.queues.producers.find(({ binding }) => binding === 'MINUTE_FACT_QUEUE').queue, 'stationhead-buddies-facts');
  assert.equal(comments.d1_databases.some(({ binding }) => binding === 'MINUTE_DB'), true);
  assert.equal(ingest.queues.producers.find(({ binding }) => binding === 'READ_MODEL_QUEUE').queue, 'stationhead-read-model');
  assert.equal(readModel.queues.consumers[0].queue, 'stationhead-read-model');
  assert.equal(minuteIngest.queues.consumers[0].queue, 'stationhead-buddies-facts');
  assert.equal(minuteIngest.queues.consumers[0].max_batch_size, 1);
  assert.deepEqual(minuteIngest.d1_databases.map(({ binding }) => binding), ['MINUTE_DB']);
  assert.equal(minuteIngest.queues.producers[0].queue, 'stationhead-minute-derive');
  assert.equal(minuteDerive.queues.consumers[0].queue, 'stationhead-minute-derive');
  assert.equal(minuteDerive.queues.consumers[0].max_batch_size, 1);
  assert.deepEqual(minuteDerive.d1_databases.map(({ binding }) => binding), ['DB', 'MINUTE_DB']);
  assert.equal(minuteMaintenance.queues.consumers, undefined);
  assert.equal(minuteMaintenance.queues.producers[0].queue, 'stationhead-minute-derive');

  const minuteIngestSource = readFileSync(new URL('../src/minute-production-entry.js', import.meta.url), 'utf8');
  const commentsSource = readFileSync(new URL('../src/comments-entry.js', import.meta.url), 'utf8');
  assert.doesNotMatch(minuteIngestSource, /runCommittedMetadataEnrichment/);
  assert.doesNotMatch(minuteIngestSource, /minute-derive-queue\.js/);
  assert.match(minuteIngestSource, /minute-derive-trigger\.js/);
  assert.match(commentsSource, /runCommittedMetadataEnrichment/);
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
      tokenExpiresAt: 9999999999999,
    }),
    fetch: async () => new Response(body, { status: 200 }),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_type, 'stationhead-raw-channel');
  assert.equal(sent[0].message_version, 3);
  assert.equal(sent[0].channel_alias, 'buddies');
  assert.equal(sent[0].snapshot.channel_id, 10);
  assert.equal(sent[0].snapshot.station_id, 123);
  assert.equal(sent[0].queue.station_id, 123);
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
    ensureSession: async () => ({
      authToken: 'token',
      deviceUid: 'device',
      tokenExpiresAt: 9999999999999,
    }),
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
    ensureSession: async () => ({
      authToken: 'token',
      deviceUid: 'device',
      tokenExpiresAt: 9999999999999,
    }),
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
  assert.throws(() => channelFromRawCollection({
    message_type: 'stationhead-raw-channel',
    message_version: 2,
    channel: [],
  }), /invalid structured raw channel payload/);
});

test('prepared collector payload preserves compact object identity and collection planning', () => {
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

test('outbox retries retain the minute payload timestamp and station identity', () => {
  const minuteFact = minuteFactQueueMessage({
    observedAt: 1_783_000_000_000,
    snapshot: { channel_id: 10, station_id: 456 },
    queue: null,
  });
  const task = commentsTaskForMinuteFact(commentsTask(), minuteFact);

  assert.equal(task.observed_at, 1_783_000_000_000);
  assert.equal(task.station_id, 456);
  assert.deepEqual(task.auth, commentsTask().auth);
  assert.equal(task.minute_fact.read_model, null);
});

test('ingest reuses the compact minute message to build the read-model envelope', () => {
  const rawObservedAt = 1_784_000_000_000;
  const processingObservedAt = rawObservedAt + 12_345;
  const queue = {
    station_id: 123,
    queue_id: 456,
    start_time: processingObservedAt - 60_000,
    is_paused: false,
    tracks: [{ position: 0, spotify_id: 'track', title: 'Song', artist: 'Artist', album_name: null, thumbnail_url: null }],
  };
  const body = minuteFactQueueMessage({
    observedAt: processingObservedAt,
    snapshot: { channel_id: 10, station_id: 123, listener_count: 99 },
    queue,
  }, {
    readModelPresentationOnly: true,
    readModel: {
      channel: {
        channel_id: 10,
        observed_at: processingObservedAt,
        presentation: { description: 'kept' },
      },
      queue: {
        station_id: 123,
        queue_id: 456,
        start_time: queue.start_time,
        is_paused: false,
        value: queue,
      },
      collector: {
        collector_id: 'cloudflare-worker',
        last_run_at: processingObservedAt,
        last_success_at: processingObservedAt,
        last_error_present: false,
        updated_at: processingObservedAt,
      },
    },
  });
  assert.equal(Object.hasOwn(body.read_model.queue, 'value'), false);

  const envelope = readModelEnvelopeForMinuteFact({
    observed_at: rawObservedAt,
    auth: commentsTask().auth,
  }, body);

  assert.equal(envelope.observed_at, rawObservedAt);
  assert.equal(envelope.job_id, `read-model:10:${rawObservedAt}`);
  assert.deepEqual(envelope.read_model.channel.presentation, { description: 'kept' });
  assert.equal(envelope.read_model.channel.observed_at, rawObservedAt);
  assert.equal(envelope.read_model.queue.value, queue);
  assert.equal(envelope.read_model.collector.last_run_at, rawObservedAt);
  assert.equal(envelope.read_model.collector.last_success_at, rawObservedAt);
  assert.equal(envelope.read_model.collector.updated_at, rawObservedAt);
  assert.equal(envelope.comment_task.station_id, 123);
  assert.deepEqual(envelope.comment_task.auth, commentsTask().auth);
});

test('comments task succeeds only after comments are durably handled', async () => {
  const result = await processCommentsTask({}, commentsTask(), {
    collectComments: async () => ({ commentsSaved: 4, degraded: false, errorStage: null }),
  });
  assert.equal(result.commentsSaved, 4);
});

test('chained comments task validates poison before calling Stationhead', async () => {
  let collected = 0;
  await assert.rejects(
    processCommentsTask({}, {
      ...commentsTask(),
      message_version: 2,
      minute_fact: { message_type: 'unknown' },
    }, {
      collectComments: async () => {
        collected += 1;
        return { commentsSaved: 0, degraded: false };
      },
    }),
    /message_type is unsupported/,
  );
  assert.equal(collected, 0);
});

test('chained comments task forwards a fully hydrated minute fact after collection', async () => {
  const minuteFact = minuteFactQueueMessage({
    observedAt: 1_784_000_000_000,
    snapshot: { channel_id: 10, station_id: 123 },
    queue: { tracks: [] },
  });
  minuteFact.read_model = null;
  const task = {
    ...commentsTask(),
    message_version: 2,
    minute_fact: minuteFact,
  };
  let sent = null;
  const result = await processCommentsTask({
    MINUTE_FACT_QUEUE: {
      async send(message) { sent = message; },
    },
  }, task, {
    collectComments: async () => ({ commentsSaved: 4, degraded: false, errorStage: null }),
    loadCommentFacts: async () => ({ commentCount: 4, commentTotal: 20 }),
  });

  assert.equal(result.forwarded, true);
  assert.equal(sent.payload.comments.commentCount, 4);
  assert.equal(sent.payload.comments.commentTotal, 20);
  assert.equal(sent.payload.comments.commentTotalKnown, true);
  assert.equal(sent.payload.comments.degraded, false);
});

test('comments task throws on degraded collection so Queue retries it', async () => {
  await assert.rejects(
    processCommentsTask({}, commentsTask(), {
      collectComments: async () => ({
        commentsSaved: 0,
        degraded: true,
        errorStage: 'd1_write_comments',
      }),
    }),
    /comment collection degraded at d1_write_comments/,
  );
});