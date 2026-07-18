import assert from 'node:assert/strict';
import test from 'node:test';

import { ingest } from '../src/collector-ingest.js';
import { processPersistenceTask } from '../src/persist-channel-entry.js';

test('raw ingest defers queue state inspection without reading D1', async () => {
  const sent = [];
  const env = {
    DB: new Proxy({}, {
      get() { throw new Error('ingest Worker must not inspect queue state'); },
    }),
    PERSIST_QUEUE: {
      async send(body) { sent.push(body); },
    },
  };
  const queue = {
    station_id: 20,
    queue_id: 30,
    tracks: [{ position: 0, spotify_id: 'sp1' }],
  };
  const result = await ingest(env, 'queue', queue, 123_456, {
    metadataRequested: true,
  });

  assert.equal(result.deferred, true);
  assert.equal(result.queue_inspected, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].metadata_requested, true);
  assert.equal(sent[0].data, queue);
});

test('persistence delegates metadata only after the durable queue write', async () => {
  const calls = [];
  const body = {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    observed_at: 123_456,
    collector_id: 'cloudflare-worker',
    metadata_requested: false,
    data: {
      station_id: 20,
      queue_id: 30,
      tracks: [{ position: 0, spotify_id: 'sp1' }],
    },
    analysis: null,
  };
  const result = await processPersistenceTask({
    DB: { prepare() {} },
  }, body, {
    async ingestOptimizedBody() {
      calls.push('persist');
      return { structure_changed: true, likes_changed: false };
    },
    async recordQueueMaterialization() {
      calls.push('materialization');
      return true;
    },
    async sendTrackMetadata(message) {
      calls.push('metadata');
      assert.equal(message.task, 'committed-enrichment');
      assert.equal(message.job.payload.queue, body.data);
      assert.equal(message.job.payload.observedAt, body.observed_at);
    },
  });

  assert.deepEqual(calls, ['persist', 'materialization', 'metadata']);
  assert.equal(result.metadata_deferred, true);
});

test('unchanged queues do not emit redundant metadata work', async () => {
  let sent = 0;
  const result = await processPersistenceTask({
    DB: { prepare() {} },
  }, {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    observed_at: 123_456,
    metadata_requested: false,
    data: {
      station_id: 20,
      queue_id: 30,
      tracks: [{ position: 0, spotify_id: 'sp1' }],
    },
    analysis: null,
  }, {
    ingestOptimizedBody: async () => ({ structure_changed: false }),
    recordQueueMaterialization: async () => true,
    sendTrackMetadata: async () => { sent += 1; },
  });

  assert.equal(sent, 0);
  assert.equal(result.metadata_deferred, false);
});
