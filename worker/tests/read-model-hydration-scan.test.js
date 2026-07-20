import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import readModelWorker, {
  processReadModelMessage,
  readModelNeedsHydration,
  readModelNeedsPreservation,
} from '../src/read-model-entry.js';

function completeTrack(index) {
  return {
    spotify_id: `spotify-${index}`,
    title: `Song ${index}`,
    artist: `Artist ${index}`,
    album_name: `Album ${index}`,
    thumbnail_url: `https://example.test/${index}.jpg`,
  };
}

function readModelWithTracks(tracks) {
  return {
    channel: { channel_id: 10, observed_at: 123, presentation: {} },
    queue: {
      station_id: 20,
      queue_id: 30,
      start_time: 100,
      is_paused: false,
      value: { tracks },
    },
    collector: {
      collector_id: 'cloudflare-worker',
      last_run_at: 123,
      last_success_at: 123,
      last_error_present: false,
      updated_at: 123,
    },
  };
}

test('read-model metadata scans distinguish hydration from preservation', () => {
  const complete = Array.from({ length: 40 }, (_, index) => completeTrack(index));
  const completeModel = readModelWithTracks(complete);
  assert.equal(readModelNeedsHydration(completeModel), false);
  assert.equal(readModelNeedsPreservation(completeModel), false);

  const incomplete = complete.slice();
  incomplete[31] = { ...incomplete[31], thumbnail_url: null };
  assert.equal(readModelNeedsHydration(readModelWithTracks(incomplete)), true);
  assert.equal(readModelNeedsPreservation(readModelWithTracks(incomplete)), true);

  const albumOnly = complete.slice();
  albumOnly[17] = { ...albumOnly[17], album_name: null };
  assert.equal(readModelNeedsHydration(readModelWithTracks(albumOnly)), false);
  assert.equal(readModelNeedsPreservation(readModelWithTracks(albumOnly)), true);

  const unidentified = [{ title: null, artist: null, album_name: null, thumbnail_url: null }, null];
  assert.equal(readModelNeedsHydration(readModelWithTracks(unidentified)), false);
  assert.equal(readModelNeedsPreservation(readModelWithTracks(unidentified)), false);
  assert.equal(readModelNeedsHydration({ queue: { value: { tracks: [] } } }), false);
  assert.equal(readModelNeedsPreservation({ queue: { value: { tracks: [] } } }), false);
  assert.equal(readModelNeedsHydration(null), false);
  assert.equal(readModelNeedsPreservation(null), false);
});

test('read-model hydration handoff reuses Queue options and preserves its payload', async () => {
  const readModel = readModelWithTracks([{ ...completeTrack(0), thumbnail_url: null }]);
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

test('album-only gaps skip hydration and start at preservation', async () => {
  const readModel = readModelWithTracks([{ ...completeTrack(0), album_name: null }]);
  const sends = [];
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.deepEqual(await processReadModelMessage({
      TRACK_METADATA_QUEUE: {
        async send(payload, options) { sends.push({ payload, options }); },
      },
    }, {
      message_type: 'stationhead-read-model',
      message_version: 1,
      job_id: 'read-model-job',
      observed_at: 123,
      read_model: readModel,
    }), { deferred: true });
  } finally {
    console.log = originalLog;
  }

  assert.equal(sends.length, 1);
  assert.equal(sends[0].payload.task, 'read-model-preserve');
  assert.strictEqual(sends[0].payload.read_model, readModel);
  assert.deepEqual(sends[0].options, { contentType: 'json' });
});

test('complete or unresolvable read models use the checkpointed writer directly', async () => {
  for (const tracks of [
    [completeTrack(0)],
    [{ title: null, artist: null, album_name: null, thumbnail_url: null }],
  ]) {
    const readModel = readModelWithTracks(tracks);
    let written = null;
    const originalLog = console.log;
    console.log = () => {};
    try {
      assert.deepEqual(await processReadModelMessage({
        TRACK_METADATA_QUEUE: {
          async send() { assert.fail('direct read-model writes must not enqueue metadata work'); },
        },
      }, {
        message_type: 'stationhead-read-model',
        message_version: 1,
        job_id: 'read-model-job',
        observed_at: 123,
        read_model: readModel,
      }, {
        async writePreparedReadModel(_env, value) { written = value; },
      }), { deferred: false });
    } finally {
      console.log = originalLog;
    }
    assert.strictEqual(written, readModel);
  }
});

test('consolidated read-model deployment keeps single-message Queue boundaries', async () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.minute-enrichment.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.queues.consumers.map(({ max_batch_size }) => max_batch_size), [1, 1, 1, 1]);
  assert.equal(config.queues.consumers.some(({ queue }) => queue === 'stationhead-read-model'), true);
  assert.deepEqual(Object.keys(readModelWorker), ['queue']);

  let acknowledged = 0;
  const readModel = readModelWithTracks([{ ...completeTrack(0), thumbnail_url: null }]);
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
