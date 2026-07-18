import assert from 'node:assert/strict';
import test from 'node:test';

import { ingest } from '../src/collector-ingest.js';
import { processPersistenceTask } from '../src/persist-channel-entry.js';

function queueBody() {
  return {
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
        bite_count: 9,
        title: 'unused title',
        raw: { unused: true },
      }],
    },
    analysis: {
      structural: {
        tracks: [{
          position: 0,
          spotify_id: 'sp1',
          isrc: 'JPABC1234567',
        }],
      },
      likes: {
        complete: true,
        payload: [{ track_key: 'isrc:JPABC1234567', like_count: 9 }],
      },
      structural_hash: 'materialized-structure',
      likes_hash: 'materialized-likes',
    },
  };
}

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

test('queue structure persistence defers likes with the full durable payload', async () => {
  const calls = [];
  let continuation = null;
  const body = queueBody();
  const result = await processPersistenceTask({
    DB: { prepare() {} },
  }, body, {
    async ingestOptimizedBody(_env, message) {
      calls.push('structure');
      assert.equal(message.data.tracks[0].bite_count, undefined);
      return { structure_changed: true, likes_changed: false };
    },
    async sendPersistenceContinuation(message) {
      calls.push('continuation');
      continuation = message;
    },
    async recordQueueMaterialization() {
      throw new Error('materialization must run after likes');
    },
  });

  assert.deepEqual(calls, ['structure', 'continuation']);
  assert.equal(result.stage, 'persist');
  assert.equal(result.likes_deferred, true);
  assert.equal(result.finalization_deferred, true);
  assert.equal(continuation.stage, 'likes');
  assert.equal(continuation.data, body.data);
  assert.equal(continuation.analysis, body.analysis);
  assert.equal(continuation.metadata_requested, true);
});

test('queue likes persistence emits a compact durable finalization', async () => {
  const initial = queueBody();
  let likes = null;
  await processPersistenceTask({ DB: { prepare() {} } }, initial, {
    ingestOptimizedBody: async () => ({ structure_changed: true }),
    sendPersistenceContinuation: async (message) => { likes = message; },
  });

  let finalize = null;
  const result = await processPersistenceTask({ DB: { prepare() {} } }, likes, {
    async ingestOptimizedBody(_env, message) {
      assert.equal(message.data, initial.data);
      return { structure_changed: false, likes_changed: true };
    },
    sendPersistenceContinuation: async (message) => { finalize = message; },
  });

  assert.equal(result.stage, 'likes');
  assert.equal(result.finalization_deferred, true);
  assert.equal(finalize.stage, 'finalize');
  assert.deepEqual(finalize.data, {
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    source_structural_hash: 'source-structure',
    source_likes_hash: 'source-likes',
    total_track_count: 45,
    materialized_track_count: 32,
  });
  assert.deepEqual(finalize.metadata_queue, {
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

test('unchanged queues traverse likes and finalize without redundant metadata work', async () => {
  const initial = queueBody();
  initial.metadata_requested = false;
  let likes = null;
  await processPersistenceTask({ DB: { prepare() {} } }, initial, {
    ingestOptimizedBody: async () => ({ structure_changed: false }),
    sendPersistenceContinuation: async (message) => { likes = message; },
  });
  assert.equal(likes.metadata_requested, false);

  let finalize = null;
  await processPersistenceTask({ DB: { prepare() {} } }, likes, {
    ingestOptimizedBody: async () => ({ structure_changed: false, likes_changed: false }),
    sendPersistenceContinuation: async (message) => { finalize = message; },
  });
  assert.equal(finalize.metadata_requested, false);
  assert.equal(Object.hasOwn(finalize, 'metadata_queue'), false);

  let sent = 0;
  const result = await processPersistenceTask({ DB: { prepare() {} } }, finalize, {
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
      tracks: [{ position: 0, spotify_id: 'sp1', bite_count: 3 }],
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

  assert.deepEqual(calls, ['persist', 'persist', 'materialization', 'metadata']);
  assert.equal(result.finalization_deferred, false);
  assert.equal(result.metadata_deferred, true);
});
