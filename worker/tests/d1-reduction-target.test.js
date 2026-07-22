import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  processBudgetedQueueStructureTask,
  queueLikesStageRequired,
  queuePersistenceCheckpointDue,
} from '../src/persist-structure-budget-entry.js';

const MINUTE_MS = 60_000;
const CHECKPOINT_MINUTES = 20;

function stableBody(observedAt) {
  return {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    observed_at: observedAt,
    collector_id: 'test',
    data: {
      station_id: 1,
      queue_id: 2,
      start_time: 3,
      tracks: [{ position: 0, spotify_id: 'track-1', bite_count: 7 }],
    },
    analysis: {
      structural_hash: 'structure-stable',
      source_structural_hash: 'structure-stable',
      likes_hash: 'likes-stable',
      source_likes_hash: 'likes-stable',
      likes: { complete: true, payload: [{ track_key: 'spotify:track-1', like_count: 7 }] },
    },
  };
}

function fakeEnv(overrides = {}) {
  return {
    DB: { prepare() { throw new Error('unexpected D1 access'); } },
    QUEUE_LIKES_REPAIR_ENABLED: false,
    QUEUE_STABLE_CHECKPOINT_MINUTES: CHECKPOINT_MINUTES,
    ...overrides,
  };
}

test('stable queue hashes bypass the second likes read stage unless repair is explicitly enabled', () => {
  const body = stableBody(21 * MINUTE_MS);
  const plan = { structure_changed: false, likes_hash: 'likes-stable' };
  assert.equal(queueLikesStageRequired(body, plan, fakeEnv()), false);
  assert.equal(queueLikesStageRequired(body, plan, fakeEnv({ QUEUE_LIKES_REPAIR_ENABLED: true })), true);
  assert.equal(queueLikesStageRequired({
    ...body,
    analysis: { ...body.analysis, likes_hash: 'likes-new' },
  }, plan, fakeEnv()), true);
  assert.equal(queueLikesStageRequired({
    ...body,
    analysis: { ...body.analysis, likes_hash: null, likes: { complete: false } },
  }, plan, fakeEnv()), true);
});

test('stable queue checkpoint is emitted only once per twenty-minute slot', () => {
  assert.equal(queuePersistenceCheckpointDue(20 * MINUTE_MS, fakeEnv()), true);
  assert.equal(queuePersistenceCheckpointDue(21 * MINUTE_MS, fakeEnv()), false);
  assert.equal(queuePersistenceCheckpointDue(39 * MINUTE_MS, fakeEnv()), false);
  assert.equal(queuePersistenceCheckpointDue(40 * MINUTE_MS, fakeEnv()), true);
});

test('stable non-checkpoint queue invocation performs one planning read and no continuation write', async () => {
  const observedAt = 21 * MINUTE_MS;
  let planningReads = 0;
  const sent = [];
  const result = await processBudgetedQueueStructureTask(
    fakeEnv(),
    stableBody(observedAt),
    {
      async prepareQueueStructurePersistence() {
        planningReads += 1;
        return {
          structure_changed: false,
          likes_hash: 'likes-stable',
          structural_hash: 'structure-stable',
        };
      },
      async sendPersistenceContinuation(message) { sent.push(message); },
    },
  );
  assert.equal(planningReads, 1);
  assert.deepEqual(sent, []);
  assert.equal(result.likes_deferred, false);
  assert.equal(result.finalization_deferred, false);
  assert.equal(result.stable_checkpoint_skipped, true);
});

test('stable checkpoint sends finalize directly and never invokes the likes comparison stage', async () => {
  const sent = [];
  const result = await processBudgetedQueueStructureTask(
    fakeEnv(),
    stableBody(20 * MINUTE_MS),
    {
      async prepareQueueStructurePersistence() {
        return {
          structure_changed: false,
          likes_hash: 'likes-stable',
          structural_hash: 'structure-stable',
        };
      },
      async sendPersistenceContinuation(message) { sent.push(message); },
    },
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, 'finalize');
  assert.equal(result.likes_deferred, false);
  assert.equal(result.finalization_deferred, true);
  assert.equal(result.stable_checkpoint_skipped, false);
});

test('completed structure change skips likes planning when the prepared likes hash is unchanged', async () => {
  const sent = [];
  const body = {
    ...stableBody(21 * MINUTE_MS),
    stage: 'structure-write',
    structure_cursor: 0,
    structure_plan: {
      structure_changed: true,
      likes_hash: 'likes-stable',
      structural_hash: 'structure-new',
      write_positions: [],
    },
  };
  const result = await processBudgetedQueueStructureTask(fakeEnv(), body, {
    async commitQueueStructurePersistence() {
      return { structureChanged: true, itemsWritten: 0 };
    },
    async sendPersistenceContinuation(message) { sent.push(message); },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, 'finalize');
  assert.equal(result.likes_deferred, false);
  assert.equal(result.finalization_deferred, true);
});

test('production stable-path model meets the requested D1 reduction targets', () => {
  const runtime = JSON.parse(readFileSync(new URL('../wrangler.runtime.jsonc', import.meta.url), 'utf8'));
  assert.equal(runtime.vars.SNAPSHOT_PERSIST_INTERVAL_MS, CHECKPOINT_MINUTES * MINUTE_MS);
  assert.equal(runtime.vars.QUEUE_STABLE_CHECKPOINT_MINUTES, CHECKPOINT_MINUTES);

  // Previous stable queue flow per 20 minutes:
  // structure plan read + likes plan read every minute, then one materialization write every minute.
  const previous = { reads: 2 * CHECKPOINT_MINUTES, writes: CHECKPOINT_MINUTES };
  // New flow: one structure plan read every minute and one checkpoint write per 20-minute window.
  const optimized = { reads: CHECKPOINT_MINUTES, writes: 1 };
  assert.ok(optimized.reads / previous.reads <= 0.50);
  assert.ok(optimized.writes / previous.writes <= 0.30);
  assert.equal(1 - optimized.reads / previous.reads, 0.50);
  assert.equal(1 - optimized.writes / previous.writes, 0.95);
});
