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

test('persistence moves post-write work to a compact durable continuation', async () => {
  const calls = [];
  let continuation = null;
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
      start_time: 40,
      source_structural_hash: 'source-structure',
      source_likes_hash: 'source-likes',
      total_track_count: 45,
      materialized_track_count: 32,
      tracks: [{
        position: 0,
        spotify_id: 'sp1',
        isrc: 'JPABC1234567',
        title: 'unused title',
        raw: { unused: true },
      }],
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
    async sendPersistenceContinuation(message) {
      calls.push('continuation');
      continuation = message;
    },
    async recordQueueMaterialization() {
      throw new Error('materialization must run in the continuation');
    },
    async sendTrackMetadata() {
      throw new Error('metadata must run in the continuation');
    },
  });

  assert.deepEqual(calls, ['persist', 'continuation']);
  assert.equal(result.stage, 'persist');
  assert.equal(result.finalization_deferred, true);
  assert.equal(continuation.stage, 'finalize');
  assert.deepEqual(continuation.data, {
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    source_structural_hash: 'source-structure',
    source_likes_hash: 'source-likes',
    total_track_count: 45,
    materialized_track_count: 32,
  });
  assert.deepEqual(continuation.metadata_queue, {
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    tracks: [{ spotify_id: 'sp1', isrc: 'JPABC1234567' }],
  });
});

test('persistence continuation records materialization before metadata delegation', async () => {
  const calls = [];
  const body = {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    stage: 'finalize',
    observed_at: 123_456,
    collector_id: 'cloudflare-worker',
    metadata_requested: true,
    data: {
      station_id: 20,
      queue_id: 30,
      start_time: 40,
      source_structural_hash: 'source-structure',
      source_likes_hash: 'source-likes',
      total_track_count: 45,
      materialized_track_count: 32,
    },
    metadata_queue: {
      station_id: 20,
      queue_id: 30,
      start_time: 40,
      tracks: [{ spotify_id: 'sp1', isrc: 'JPABC1234567' }],
    },
  };
  const result = await processPersistenceTask({
    DB: { prepare() {} },
  }, body, {
    async ingestOptimizedBody() {
      throw new Error('queue ingest must not repeat in the continuation');
    },
    async recordQueueMaterialization(_db, queue) {
      calls.push('materialization');
      assert.equal(queue, body.data);
      return true;
    },
    async sendTrackMetadata(message) {
      calls.push('metadata');
      assert.equal(message.task, 'committed-enrichment');
      assert.equal(message.job.payload.queue, body.metadata_queue);
      assert.equal(message.job.payload.observedAt, body.observed_at);
    },
  });

  assert.deepEqual(calls, ['materialization', 'metadata']);
  assert.equal(result.stage, 'finalize');
  assert.equal(result.materialization_recorded, true);
  assert.equal(result.metadata_deferred, true);
  assert.equal(result.finalization_deferred, false);
});

test('unchanged queues finalize without redundant metadata work', async () => {
  let continuation = null;
  const initial = {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    observed_at: 123_456,
    metadata_requested: false,
    data: {
      station_id: 20,
      queue_id: 30,
      start_time: 40,
      source_structural_hash: 'source-structure',
      total_track_count: 1,
      materialized_track_count: 1,
      tracks: [{ position: 0, spotify_id: 'sp1' }],
    },
    analysis: null,
  };
  await processPersistenceTask({ DB: { prepare() {} } }, initial, {
    ingestOptimizedBody: async () => ({ structure_changed: false }),
    sendPersistenceContinuation: async (message) => { continuation = message; },
  });

  assert.equal(continuation.metadata_requested, false);
  assert.equal(Object.hasOwn(continuation, 'metadata_queue'), false);

  let sent = 0;
  const result = await processPersistenceTask({ DB: { prepare() {} } }, continuation, {
    recordQueueMaterialization: async () => true,
    sendTrackMetadata: async () => { sent += 1; },
  });

  assert.equal(sent, 0);
  assert.equal(result.metadata_deferred, false);
});

test('direct persistence callers retain inline finalization without the self queue binding', async () => {
  const calls = [];
  const result = await processPersistenceTask({
    DB: { prepare() {} },
  }, {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    observed_at: 123_456,
    metadata_requested: true,
    data: {
      station_id: 20,
      queue_id: 30,
      tracks: [{ position: 0, spotify_id: 'sp1' }],
    },
    analysis: null,
  }, {
    ingestOptimizedBody: async () => {
      calls.push('persist');
      return { structure_changed: false };
    },
    recordQueueMaterialization: async () => {
      calls.push('materialization');
      return true;
    },
    sendTrackMetadata: async () => {
      calls.push('metadata');
    },
  });

  assert.deepEqual(calls, ['persist', 'materialization', 'metadata']);
  assert.equal(result.finalization_deferred, false);
  assert.equal(result.metadata_deferred, true);
});
