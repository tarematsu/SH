import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { collectRawChannel } from '../src/raw-collector-entry.js';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('split pipeline has one producer and one consumer for each queue boundary', () => {
  const buddies = config('wrangler.jsonc');
  const ingest = config('wrangler.ingest.jsonc');
  const comments = config('wrangler.comments.jsonc');
  const readModel = config('wrangler.read-model.jsonc');

  assert.equal(buddies.main, 'src/raw-collector-entry.js');
  assert.equal(ingest.main, 'src/ingest-channel-entry.js');
  assert.equal(comments.main, 'src/comments-entry.js');
  assert.equal(readModel.main, 'src/read-model-entry.js');

  assert.equal(buddies.queues.producers[0].queue, 'stationhead-raw-collection');
  assert.equal(ingest.queues.consumers[0].queue, 'stationhead-raw-collection');
  assert.equal(ingest.queues.producers.find(({ binding }) => binding === 'COMMENTS_QUEUE').queue, 'stationhead-comments');
  assert.equal(comments.queues.consumers[0].queue, 'stationhead-comments');
  assert.equal(ingest.queues.producers.find(({ binding }) => binding === 'READ_MODEL_QUEUE').queue, 'stationhead-read-model');
  assert.equal(readModel.queues.consumers[0].queue, 'stationhead-read-model');
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
