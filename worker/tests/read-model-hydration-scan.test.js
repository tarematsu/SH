import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import readModelWorker, { processReadModelMessage, readModelNeedsHydration } from '../src/read-model-entry.js';

function completeTrack(index) {
  return {
    title: `Song ${index}`,
    artist: `Artist ${index}`,
    album_name: `Album ${index}`,
    thumbnail_url: `https://example.test/${index}.jpg`,
  };
}

test('read-model hydration scan preserves complete and incomplete queue decisions', () => {
  const complete = Array.from({ length: 40 }, (_, index) => completeTrack(index));
  assert.equal(readModelNeedsHydration({ queue: { value: { tracks: complete } } }), false);

  const incomplete = complete.slice();
  incomplete[31] = { ...incomplete[31], thumbnail_url: null };
  assert.equal(readModelNeedsHydration({ queue: { value: { tracks: incomplete } } }), true);
  assert.equal(readModelNeedsHydration({ queue: { value: { tracks: [] } } }), false);
  assert.equal(readModelNeedsHydration(null), false);
});

test('read-model hydration handoff reuses Queue options and preserves its payload', async () => {
  const readModel = {
    queue: {
      value: {
        tracks: [{ ...completeTrack(0), thumbnail_url: null }],
      },
    },
  };
  const sends = [];
  const env = {
    TRACK_METADATA_QUEUE: {
      async send(payload, options) {
        sends.push({ payload, options });
      },
    },
  };
  const body = {
    message_type: 'stationhead-read-model',
    message_version: 1,
    job_id: 'read-model-job',
    observed_at: '123',
    read_model: readModel,
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.deepEqual(await processReadModelMessage(env, body), { deferred: true });
    assert.deepEqual(await processReadModelMessage(env, body), { deferred: true });
  } finally {
    console.log = originalLog;
  }

  assert.equal(sends.length, 2);
  assert.strictEqual(sends[0].options, sends[1].options);
  assert.deepEqual(sends[0].options, { contentType: 'json' });
  assert.strictEqual(sends[0].payload.read_model, readModel);
  assert.deepEqual(sends[0].payload, {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'read-model-hydration',
    job_id: 'read-model-job',
    observed_at: 123,
    read_model: readModel,
  });
});

test('consolidated read-model deployment keeps single-message Queue boundaries', async () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.pages-read-model.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.queues.consumers.map(({ max_batch_size }) => max_batch_size), [1, 1]);
  assert.equal(config.queues.consumers.some(({ queue }) => queue === 'stationhead-read-model'), true);
  assert.deepEqual(Object.keys(readModelWorker), ['queue']);

  let acknowledged = 0;
  const readModel = {
    queue: { value: { tracks: [{ ...completeTrack(0), thumbnail_url: null }] } },
  };
  const messages = [{
    body: {
      message_type: 'stationhead-read-model',
      message_version: 1,
      job_id: 'read-model-job',
      observed_at: 123,
      read_model: readModel,
    },
    ack() { acknowledged += 1; },
    retry() { assert.fail('valid read-model handoff must not retry'); },
  }, {
    get body() { assert.fail('single-message dispatch must not read a second body'); },
  }];
  Object.defineProperty(messages, Symbol.iterator, {
    configurable: true,
    get() { assert.fail('read-model batch iterator was accessed'); },
  });

  const originalLog = console.log;
  console.log = () => {};
  try {
    await readModelWorker.queue({ messages }, {
      TRACK_METADATA_QUEUE: { send: async () => {} },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(acknowledged, 1);
});
