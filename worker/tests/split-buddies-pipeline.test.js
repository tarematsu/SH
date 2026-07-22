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

test('the core Worker has one owner per non-Sakurazaka Queue boundary', () => {
  const runtime = config('wrangler.runtime.jsonc');
  assert.equal(runtime.main, 'src/runtime-orchestrator-deployed-entry.js');
  assert.equal(runtime.queues.producers.find(({ binding }) => binding === 'RAW_COLLECTION_QUEUE').queue, 'stationhead-raw-collection');

  const consumers = new Map(runtime.queues.consumers.map((consumer) => [consumer.queue, consumer]));
  for (const queue of [
    'stationhead-raw-collection',
    'stationhead-comments',
    'stationhead-buddies-persist',
    'stationhead-read-model',
    'stationhead-buddies-facts',
    'stationhead-minute-live-derive',
    'stationhead-minute-rebuild',
  ]) {
    assert.equal(consumers.get(queue).max_batch_size, 1, queue);
  }
  assert.deepEqual(runtime.d1_databases.map(({ binding }) => binding), [
    'BUDDIES_DB',
    'MINUTE_DB',
    'OTHER_DB',
  ]);
  assert.equal(runtime.queues.producers.find(({ binding }) => binding === 'MINUTE_FACT_QUEUE').queue, 'stationhead-buddies-facts');
  assert.equal(consumers.get('stationhead-buddies-facts').max_concurrency, 1);
  assert.equal(consumers.get('stationhead-minute-live-derive').max_concurrency, 2);
  assert.equal(consumers.get('stationhead-minute-rebuild').max_concurrency, 1);
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
  await collectRawChannel({
    CHANNEL_ALIAS: 'buddies',
    REQUEST_TIMEOUT_MS: 8_000,
    RAW_COLLECTION_QUEUE: { async send(message) { sent.push(message); } },
  }, {
    ensureSession: async () => ({ authToken: 'token', deviceUid: 'device', tokenExpiresAt: 9_999_999_999_999 }),
    fetch: async () => new Response(body, { status: 200 }),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_version, 3);
  assert.equal(sent[0].snapshot.channel_id, 10);
  assert.equal(sent[0].queue.queue_id, 456);
  assert.equal(sent[0].queue.tracks[0].spotify_id, 'track');
  assert.equal(Object.hasOwn(sent[0], 'body'), false);
});

test('raw payload compatibility keeps v2 validation and v1 poison paths', async () => {
  const sent = [];
  const env = {
    CHANNEL_ALIAS: 'buddies',
    REQUEST_TIMEOUT_MS: 8_000,
    RAW_COLLECTION_QUEUE: { async send(message) { sent.push(message); } },
  };
  const auth = async () => ({ authToken: 'token', deviceUid: 'device', tokenExpiresAt: 9_999_999_999_999 });

  const validUnexpected = '{"id":10,"alias":"unexpected","current_station_id":123}';
  await collectRawChannel(env, {
    ensureSession: auth,
    fetch: async () => new Response(validUnexpected, { status: 200 }),
  });
  assert.equal(sent[0].message_version, 2);
  assert.deepEqual(sent[0].channel, JSON.parse(validUnexpected));

  const malformed = '{"id":10';
  await collectRawChannel(env, {
    ensureSession: auth,
    fetch: async () => new Response(malformed, { status: 200 }),
  });
  assert.equal(sent[1].message_version, 1);
  assert.equal(sent[1].body, malformed);
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

test('prepared collector payload and read-model envelope preserve source timestamps', () => {
  const rawObservedAt = 1_784_000_000_000;
  const processingObservedAt = rawObservedAt + 12_345;
  const snapshot = { channel_id: 10, station_id: 123 };
  const queue = { station_id: 123, queue_id: 456, start_time: processingObservedAt - 60_000, tracks: [] };
  const state = { channelId: null, stationId: null };
  const prepared = preparedCollectionPayload(
    { snapshot, queue },
    state,
    { metadataRefreshIntervalMs: 15 * 60_000 },
    rawObservedAt,
    processingObservedAt,
    false,
  );
  assert.equal(prepared.snapshot, snapshot);
  assert.equal(prepared.queue, queue);
  assert.equal(state.channelId, 10);
  assert.equal(state.stationId, 123);

  const minuteFact = minuteFactQueueMessage({ observedAt: processingObservedAt, snapshot, queue });
  const task = commentsTaskForMinuteFact(commentsTask(), minuteFact);
  assert.equal(task.observed_at, processingObservedAt);
  assert.equal(task.station_id, 123);

  const envelope = readModelEnvelopeForMinuteFact({
    observed_at: rawObservedAt,
    auth: commentsTask().auth,
  }, {
    ...minuteFact,
    read_model: {
      channel: { channel_id: 10, observed_at: processingObservedAt, presentation: { description: 'kept' } },
      queue: { station_id: 123, value: queue },
      collector: { collector_id: 'cloudflare-worker', updated_at: processingObservedAt },
    },
  });
  assert.equal(envelope.observed_at, rawObservedAt);
  assert.equal(envelope.job_id, `read-model:10:${rawObservedAt}`);
  assert.equal(envelope.read_model.queue.value, queue);
  assert.equal(envelope.comment_task.station_id, 123);
});

test('comments task acknowledges only durable success and retries degraded collection', async () => {
  assert.equal((await processCommentsTask({}, commentsTask(), {
    collectComments: async () => ({ commentsSaved: 4, degraded: false, errorStage: null }),
  })).commentsSaved, 4);

  let collected = 0;
  await assert.rejects(processCommentsTask({}, {
    ...commentsTask(),
    message_version: 2,
    minute_fact: { message_type: 'unknown' },
  }, {
    collectComments: async () => { collected += 1; return { commentsSaved: 0, degraded: false }; },
  }), /message_type is unsupported/);
  assert.equal(collected, 0);

  await assert.rejects(processCommentsTask({}, commentsTask(), {
    collectComments: async () => ({ commentsSaved: 0, degraded: true, errorStage: 'd1_write_comments' }),
  }), /comment collection degraded at d1_write_comments/);
});
