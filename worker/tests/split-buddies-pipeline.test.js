import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { processCommentsTask } from '../src/comments-entry.js';
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

test('split pipeline has one owner for each queue boundary', () => {
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
  assert.equal(ingest.queues.producers.find(({ binding }) => binding === 'READ_MODEL_QUEUE').queue, 'stationhead-read-model');
  assert.equal(readModel.queues.consumers[0].queue, 'stationhead-read-model');
  assert.equal(minuteIngest.queues.consumers[0].queue, 'stationhead-buddies-facts');
  assert.equal(minuteIngest.queues.consumers[0].max_batch_size, 1);
  assert.equal(minuteIngest.queues.producers[0].queue, 'stationhead-minute-derive');
  assert.equal(minuteDerive.queues.consumers[0].queue, 'stationhead-minute-derive');
  assert.equal(minuteDerive.queues.consumers[0].max_batch_size, 1);
  assert.equal(minuteMaintenance.queues.consumers, undefined);
  assert.equal(minuteMaintenance.queues.producers[0].queue, 'stationhead-minute-derive');
});

test('raw collector forwards the response body without parsing it', async () => {
  const sent = [];
  const body = '{"large":"payload","queue":[1,2,3]}';
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
  assert.equal(sent[0].body, body);
  assert.equal(sent[0].message_type, 'stationhead-raw-channel');
  assert.equal(sent[0].channel_alias, 'buddies');
});

test('comments task succeeds only after comments are durably handled', async () => {
  const result = await processCommentsTask({}, commentsTask(), {
    collectComments: async () => ({ commentsSaved: 4, degraded: false, errorStage: null }),
  });
  assert.equal(result.commentsSaved, 4);
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
