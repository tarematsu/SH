import assert from 'node:assert/strict';
import test from 'node:test';

import { processPersistenceBatch } from '../src/persist-channel-optimized-entry.js';
import {
  prepareQueueLikesPersistenceWithinBudget,
  processOptimizedQueueLikesPlanTask,
} from '../src/persist-likes-plan-entry.js';
import { processBudgetedQueueStructureTask } from '../src/persist-structure-budget-entry.js';
import {
  invalidateQueuePlanR2,
  loadQueuePlanR2,
  saveQueuePlanR2,
} from '../src/queue-plan-r2.js';

function queueBody(stage = 'persist') {
  return {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    stage,
    observed_at: 120_000,
    collector_id: 'test',
    metadata_requested: true,
    data: {
      station_id: 1,
      queue_id: 2,
      start_time: 3,
      tracks: [{
        position: 0,
        queue_track_id: 10,
        spotify_id: 'track-1',
        isrc: 'JPTEST000001',
        bite_count: 7,
      }],
    },
    analysis: {
      structural_hash: 'structure-new',
      likes_hash: 'likes-stable',
      likes: {
        complete: true,
        payload: [{ track_key: 'isrc:JPTEST000001', like_count: 7 }],
      },
    },
  };
}

function statement(sql, state) {
  return {
    sql,
    params: [],
    bind(...params) {
      const bound = statement(sql, state);
      bound.params = params;
      return bound;
    },
    async first() {
      if (sql.includes('FROM sh_queue_current')) return state.current;
      return null;
    },
    async all() { return { results: [] }; },
    async run() { return { meta: { changes: 1 } }; },
  };
}

test('structure writes do not publish a stable cache before the likes stage completes', async () => {
  const body = {
    ...queueBody('structure-write'),
    structure_cursor: 0,
    structure_plan: {
      structure_changed: true,
      stale_current: false,
      station_id: 1,
      queue_id: 2,
      start_time: 3,
      structural_hash: 'structure-new',
      likes_hash: 'likes-stable',
      write_positions: [0],
    },
  };
  const sent = [];
  const cacheWrites = [];
  const result = await processBudgetedQueueStructureTask(
    { DB: { prepare() {} }, PAGES_RESPONSE_R2: {} },
    body,
    {
      commitQueueStructurePersistence: async () => ({ structureChanged: true, itemsWritten: 1 }),
      sendPersistenceContinuation: async (message) => sent.push(message),
      saveQueuePlanCache: async (...args) => cacheWrites.push(args),
    },
  );

  assert.equal(result.likes_deferred, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, 'likes');
  assert.deepEqual(cacheWrites, []);
});

test('structure-triggered likes planning repairs new null bite counts even when routine repair is disabled', async () => {
  const body = queueBody('likes');
  const state = {
    current: {
      structural_hash: 'structure-new',
      likes_hash: 'likes-stable',
      observed_at: 60_000,
      latest_reachability_at: 60_000,
    },
  };
  const DB = {
    prepare(sql) { return statement(sql, state); },
    async batch(statements) {
      assert.equal(statements.length, 1);
      assert.match(statements[0].sql, /bite_count IS NULL/);
      return [{ success: true, results: [{ position: 0 }] }];
    },
  };

  const plan = await prepareQueueLikesPersistenceWithinBudget({
    DB,
    QUEUE_LIKES_REPAIR_ENABLED: false,
  }, body, body.observed_at);

  assert.equal(plan.likes_changed, false);
  assert.equal(plan.needs_write, true);
  assert.deepEqual(plan.queue_item_positions, [0]);
});

test('a no-write likes plan enqueues finalization before publishing the stable cache', async () => {
  const body = queueBody('likes');
  const plan = {
    needs_write: false,
    likes_changed: false,
    station_id: 1,
    queue_id: 2,
    start_time: 3,
    structural_hash: 'structure-new',
    likes_hash: 'likes-stable',
    track_count: 1,
  };

  await assert.rejects(processOptimizedQueueLikesPlanTask(
    { DB: { prepare() {} } },
    body,
    { prepareQueueLikesPersistence: async () => plan },
  ), /PERSIST_QUEUE binding is missing for finalization/);

  const order = [];
  const result = await processOptimizedQueueLikesPlanTask(
    { DB: { prepare() {} }, PAGES_RESPONSE_R2: {} },
    body,
    {
      prepareQueueLikesPersistence: async () => plan,
      sendPersistenceContinuation: async (message) => order.push(`send:${message.stage}`),
      saveQueuePlanCache: async () => order.push('cache'),
    },
  );
  assert.equal(result.finalization_deferred, true);
  assert.deepEqual(order, ['send:finalize', 'cache']);
});

test('the final likes-write message publishes the cache only after finalization is durable', async () => {
  const body = {
    ...queueBody('likes-write'),
    likes_cursor: 0,
    likes_plan: {
      likes_changed: true,
      station_id: 1,
      queue_id: 2,
      start_time: 3,
      structural_hash: 'structure-new',
      likes_hash: 'likes-new',
      track_count: 1,
    },
  };
  const order = [];
  let acked = false;
  let retried = false;
  await processPersistenceBatch({
    messages: [{
      body,
      ack() { acked = true; order.push('ack'); },
      retry() { retried = true; },
    }],
  }, {
    DB: { prepare() {} },
    PAGES_RESPONSE_R2: {},
  }, {
    commitQueueLikesPersistenceChunk: async () => ({
      likesChanged: true,
      likes_write_complete: true,
      next_cursor: null,
    }),
    sendPersistenceContinuation: async (message) => order.push(`send:${message.stage}`),
    saveQueuePlanCache: async () => order.push('cache'),
  });

  assert.equal(acked, true);
  assert.equal(retried, false);
  assert.deepEqual(order, ['send:finalize', 'cache', 'ack']);
});

test('R2 queue-plan cache failures never fail the authoritative D1 pipeline', async () => {
  const body = queueBody();
  const plan = {
    station_id: 1,
    queue_id: 2,
    start_time: 3,
    structural_hash: 'structure-new',
    likes_hash: 'likes-stable',
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (value) => warnings.push(String(value));
  try {
    assert.equal(await saveQueuePlanR2({
      async put() { throw new Error('R2 put unavailable'); },
    }, body, body.observed_at, plan), false);
    assert.equal(await invalidateQueuePlanR2({
      async delete() { throw new Error('R2 delete unavailable'); },
    }, body), false);
    assert.equal(await loadQueuePlanR2({
      async get() {
        return { async json() { return { version: 0 }; } };
      },
      async delete() { throw new Error('R2 cleanup unavailable'); },
    }, body, body.observed_at), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join('\n'), /queue_plan_r2_write_failed/);
  assert.match(warnings.join('\n'), /queue_plan_r2_delete_failed/);
});
