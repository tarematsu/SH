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
  assert.equal(ingest.main, 'src/ingest-channel-optimized-entry.js');
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
          id: 789,
          track: {
            id: 321,
            spotify_id: 'spotify-1',
            isrc: 'JPABC1234567',
            duration: 180_000,
            title: 'Song',
            artist: { name: 'Artist' },
            album: { name: 'Album' },
          },
        }],
      },
    },
  });
  await collectRawChannel({
    RAW_COLLECTION_QUEUE: { send: async (message) => sent.push(message) },
  }, {
    ensureSession: async () => ({ authToken: 'token', deviceUid: 'device' }),
    fetch: async () => new Response(body, { status: 200 }),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_version, 3);
  assert.equal(sent[0].body, undefined);
  assert.equal(sent[0].channel, undefined);
  assert.equal(sent[0].snapshot.channel_id, 10);
  assert.equal(sent[0].snapshot.station_id, 123);
  assert.equal(sent[0].snapshot.raw, undefined);
  assert.equal(sent[0].queue.station_id, 123);
  assert.equal(sent[0].queue.tracks.length, 1);
  assert.equal(sent[0].queue.tracks[0].spotify_id, 'spotify-1');
});

test('raw collector retains valid unexpected payloads on the legacy v2 path', async () => {
  const sent = [];
  const channel = {
    id: 10,
    alias: 'buddies',
    current_station_id: null,
  };
  await collectRawChannel({
    RAW_COLLECTION_QUEUE: { send: async (message) => sent.push(message) },
  }, {
    ensureSession: async () => ({ authToken: 'token', deviceUid: 'device' }),
    fetch: async () => new Response(JSON.stringify(channel), { status: 200 }),
  });

  assert.equal(sent[0].message_version, 2);
  assert.deepEqual(sent[0].channel, channel);
});

test('raw collector retains invalid JSON on the legacy v1 poison path', async () => {
  const sent = [];
  await collectRawChannel({
    RAW_COLLECTION_QUEUE: { send: async (message) => sent.push(message) },
  }, {
    ensureSession: async () => ({ authToken: 'token', deviceUid: 'device' }),
    fetch: async () => new Response('not-json', { status: 200 }),
  });

  assert.equal(sent[0].message_version, 1);
  assert.equal(sent[0].body, 'not-json');
});

test('prepared v3 collection bypasses channel normalization in ingest', () => {
  const message = {
    message_type: 'stationhead-raw-channel',
    message_version: 3,
    channel_alias: 'buddies',
    snapshot: { channel_id: 10, station_id: 123, channel_alias: 'buddies' },
    queue: { station_id: 123, tracks: [] },
  };
  const collection = collectionFromRawCollection(message);
  assert.equal(collection.prepared, true);
  assert.equal(collection.channel, null);
  assert.equal(collection.snapshot, message.snapshot);
  assert.equal(collection.queue, message.queue);
  assert.throws(() => channelFromRawCollection(message), /does not contain a channel payload/);
});

test('prepared collection payload reuses the normalized snapshot and queue', () => {
  const snapshot = { channel_id: 10, station_id: 123 };
  const queue = { station_id: 123, tracks: [] };
  const state = { channelId: null, stationId: null };
  const result = preparedCollectionPayload({ snapshot, queue }, state, {
    metadataRefreshIntervalMs: 1000,
  }, 0, 1_784_000_000_000, false);
  assert.equal(result.snapshot, snapshot);
  assert.equal(result.queue, queue);
  assert.equal(state.channelId, 10);
  assert.equal(state.stationId, 123);
});

test('comments task v1 remains independent of minute-fact forwarding', async () => {
  const result = await processCommentsTask({}, commentsTask(), {
    collectComments: async () => ({ commentsSaved: 4, degraded: false }),
  });
  assert.equal(result.commentsSaved, 4);
  assert.equal(result.forwarded, false);
});

test('comments task v2 forwards the embedded minute fact after collection', async () => {
  let sent;
  const task = {
    ...commentsTask(),
    message_version: 2,
    minute_fact: minuteFactQueueMessage({
      observedAt: 1_784_000_000_000,
      snapshot: { channel_id: 10, station_id: 123 },
      queue: { tracks: [] },
    }),
  };
  const result = await processCommentsTask({}, task, {
    collectComments: async () => ({ commentsSaved: 4, degraded: false }),
    loadCommentFacts: async () => ({ commentCount: 4, commentTotal: 12 }),
    sendMinuteFact: async (message) => { sent = message; },
  });
  assert.equal(result.forwarded, true);
  assert.equal(sent.payload.comments.commentCount, 4);
  assert.equal(sent.payload.comments.commentTotal, 12);
});

test('comments task throws on degraded collection so Queue retries it', async () => {
  await assert.rejects(
    () => processCommentsTask({}, commentsTask(), {
      collectComments: async () => ({ commentsSaved: 0, degraded: true, errorStage: 'sh_chat_history' }),
    }),
    /comment collection degraded/,
  );
});
