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
        station_id: 20,
        queue_id: 30,
        start_time: 40,
        is_paused: 0,
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

function structurePlan(overrides = {}) {
  return {
    structure_changed: true,
    stale_current: false,
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    structural_hash: 'materialized-structure',
    likes_hash: 'previous-likes',
    all_positions: [0],
    write_positions: [0],
    claim: { accepted: true, duplicate: false, reason: 'claimed', hash: 'materialized-structure' },
    ...overrides,
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

test('queue persistence plan defers structural writes without running the ingest handler', async () => {
  const calls = [];
  let continuation = null;
  const body = queueBody();
  const plan = structurePlan();
  const result = await processPersistenceTask({ DB: { prepare() {} } }, body, {
    async prepareQueueStructurePersistence(_db, task, observedAt) {
      calls.push('plan');
      assert.equal(task, body);
      assert.equal(observedAt, body.observed_at);
      return plan;
    },
    async commitQueueStructurePersistence() {
      throw new Error('structure write must run in its continuation');
    },
    async ingestOptimizedBody() {
      throw new Error('likes must run after the structure write');
    },
    async sendPersistenceContinuation(message) {
      calls.push('continuation');
      continuation = message;
    },
  });

  assert.deepEqual(calls, ['plan', 'continuation']);
  assert.equal(result.stage, 'persist');
  assert.equal(result.structure_write_deferred, true);
  assert.equal(result.finalization_deferred, true);
  assert.equal(continuation.stage, 'structure-write');
  assert.equal(continuation.data, body.data);
  assert.equal(continuation.analysis, body.analysis);
  assert.equal(continuation.structure_plan, plan);
  assert.equal(continuation.metadata_requested, true);
});

test('structural write continuation defers likes with the original queue payload', async () => {
  const initial = queueBody();
  const body = {
    ...initial,
    stage: 'structure-write',
    structure_plan: structurePlan(),
    metadata_requested: true,
  };
  let continuation = null;
  const result = await processPersistenceTask({ DB: { prepare() {} } }, body, {
    async commitQueueStructurePersistence(_db, task, observedAt, plan) {
      assert.equal(task, body);
      assert.equal(observedAt, body.observed_at);
      assert.equal(plan, body.structure_plan);
      return { structureChanged: true, itemsWritten: 1 };
    },
    async sendPersistenceContinuation(message) {
      continuation = message;
    },
  });

  assert.equal(result.stage, 'structure-write');
  assert.equal(result.likes_deferred, true);
  assert.equal(result.finalization_deferred, true);
  assert.equal(continuation.stage, 'likes');
  assert.equal(continuation.data, initial.data);
  assert.equal(continuation.analysis, initial.analysis);
  assert.equal(continuation.metadata_requested, true);
});

test('queue likes persistence emits a compact durable finalization', async () => {
  const initial = queueBody();
  const likes = {
    ...initial,
    stage: 'likes',
    metadata_requested: true,
  };
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
  const result = await processPersistenceTask({ DB: { prepare() {} } }, body, {
    async recordQueueMaterialization(_db, queue) {
      calls.push('materialization');
      assert.equal(queue, body.data);
      return true;
    },
    async sendTrackMetadata(message) {
      calls.push('metadata');
      assert.equal(message.task, 'committed-enrichment');
      assert.equal(message.job.payload.queue, body.metadata_queue);
    },
  });

  assert.deepEqual(calls, ['materialization', 'metadata']);
  assert.equal(result.stage, 'finalize');
  assert.equal(result.materialization_recorded, true);
  assert.equal(result.metadata_deferred, true);
  assert.equal(result.finalization_deferred, false);
});

test('unchanged queues still pass through structure write and likes without metadata', async () => {
  const initial = queueBody();
  initial.metadata_requested = false;
  const plan = structurePlan({ structure_changed: false, write_positions: [] });
  let structureWrite = null;
  await processPersistenceTask({ DB: { prepare() {} } }, initial, {
    prepareQueueStructurePersistence: async () => plan,
    sendPersistenceContinuation: async (message) => { structureWrite = message; },
  });
  assert.equal(structureWrite.metadata_requested, false);

  let likes = null;
  await processPersistenceTask({ DB: { prepare() {} } }, structureWrite, {
    commitQueueStructurePersistence: async () => ({ structureChanged: false, itemsWritten: 0 }),
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
});

test('direct persistence callers retain inline completion without the self queue binding', async () => {
  const calls = [];
  const body = queueBody();
  body.metadata_requested = true;
  const result = await processPersistenceTask({ DB: { prepare() {} } }, body, {
    prepareQueueStructurePersistence: async () => {
      calls.push('plan');
      return structurePlan();
    },
    commitQueueStructurePersistence: async () => {
      calls.push('structure');
      return { structureChanged: true, itemsWritten: 1 };
    },
    ingestOptimizedBody: async () => {
      calls.push('likes');
      return { structure_changed: false, likes_changed: true };
    },
    recordQueueMaterialization: async () => {
      calls.push('materialization');
      return true;
    },
    sendTrackMetadata: async () => {
      calls.push('metadata');
    },
  });

  assert.deepEqual(calls, ['plan', 'structure', 'likes', 'materialization', 'metadata']);
  assert.equal(result.finalization_deferred, false);
  assert.equal(result.metadata_deferred, true);
});
