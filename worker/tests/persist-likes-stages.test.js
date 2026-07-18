import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitQueueLikesPersistenceChunk,
  LIKES_WRITE_TRACK_LIMIT,
  prepareQueueLikesPersistence,
  processOptimizedQueueLikesTask,
  QUEUE_STAGE_LIKES_WRITE,
} from '../src/persist-likes-stages.js';
import { processPersistenceBatch } from '../src/persist-channel-optimized-entry.js';

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
      state.firsts.push(this);
      return state.first(this);
    },
    async all() {
      state.alls.push(this);
      return state.all(this);
    },
    async run() {
      state.runs.push(this);
      return { success: true, meta: { changes: 1 } };
    },
  };
}

function queueBody(trackCount = 2) {
  const tracks = Array.from({ length: trackCount }, (_, position) => ({
    position,
    queue_track_id: 100 + position,
    stationhead_track_id: 200 + position,
    spotify_id: `sp${position}`,
    isrc: `JPABC12345${String(position).padStart(2, '0')}`,
    bite_count: position + 10,
  }));
  return {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    stage: 'likes',
    observed_at: 123_456,
    collector_id: 'cloudflare-worker',
    metadata_requested: true,
    data: {
      station_id: 20,
      queue_id: 30,
      start_time: 40,
      total_track_count: trackCount,
      materialized_track_count: trackCount,
      tracks,
    },
    analysis: {
      structural_hash: 'structure-hash',
      likes_hash: 'new-likes-hash',
      likes: {
        complete: true,
        payload: tracks.map((track) => ({
          track_key: `isrc:${track.isrc}`,
          like_count: track.bite_count,
        })),
      },
    },
  };
}

function stateWithCurrent(body, likesHash = 'old-likes-hash') {
  return {
    firsts: [],
    alls: [],
    runs: [],
    first(entry) {
      if (entry.sql.includes('FROM sh_queue_current')) {
        return {
          structural_hash: 'structure-hash',
          likes_hash: likesHash,
          observed_at: 120_000,
          latest_reachability_at: 120_000,
        };
      }
      throw new Error(`unexpected first SQL: ${entry.sql}`);
    },
    all() { return { results: [] }; },
    body,
  };
}

test('likes planning combines null queue-item positions with changed-like positions', async () => {
  const body = queueBody(2);
  const state = stateWithCurrent(body);
  const db = {
    prepare(sql) { return statement(sql, state); },
    async batch(statements) {
      return statements.map((entry, index) => {
        if (index === 0) return { success: true, results: [{ position: 0 }] };
        return {
          success: true,
          results: body.data.tracks.map((track, trackIndex) => ({
            track_key: `isrc:${track.isrc}`,
            isrc: track.isrc,
            spotify_id: track.spotify_id,
            like_count: trackIndex === 0 ? track.bite_count : 1,
            observed_at: 100_000,
          })),
        };
      });
    },
  };

  const plan = await prepareQueueLikesPersistence(db, body, body.observed_at);

  assert.equal(plan.likes_changed, true);
  assert.equal(plan.needs_write, true);
  assert.deepEqual(plan.queue_item_positions.sort((a, b) => a - b), [0, 1]);
  assert.deepEqual(plan.observation_keys, [body.analysis.likes.payload[1].track_key]);
  assert.deepEqual(plan.current_track_keys, body.analysis.likes.payload.map((entry) => entry.track_key));
});

test('unchanged likes still repair structurally inserted null bite counts', async () => {
  const body = queueBody(1);
  const state = stateWithCurrent(body, 'new-likes-hash');
  const db = {
    prepare(sql) { return statement(sql, state); },
    async batch(statements) {
      assert.equal(statements.length, 1);
      return [{ success: true, results: [{ position: 0 }] }];
    },
  };

  const plan = await prepareQueueLikesPersistence(db, body, body.observed_at);

  assert.equal(plan.likes_changed, false);
  assert.equal(plan.needs_write, true);
  assert.deepEqual(plan.queue_item_positions, [0]);
});

test('likes writes are bounded to the configured track chunk and D1 variable limit', async () => {
  const body = queueBody(30);
  body.stage = QUEUE_STAGE_LIKES_WRITE;
  const batches = [];
  const state = {
    firsts: [],
    alls: [],
    runs: [],
    first() { return null; },
    all() { return { results: [] }; },
  };
  const db = {
    prepare(sql) { return statement(sql, state); },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  const plan = {
    likes_changed: false,
    complete_likes: true,
    stale_current: false,
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    structural_hash: 'structure-hash',
    likes_hash: 'likes-hash',
    current_track_keys: [],
    observation_keys: [],
    migration_keys: [],
    queue_item_positions: body.data.tracks.map((track) => track.position),
  };

  const first = await commitQueueLikesPersistenceChunk(db, body, body.observed_at, plan, 0);
  const firstStatementCount = batches.flat().length;
  const firstBatchSizes = batches.map((batch) => batch.length);
  const second = await commitQueueLikesPersistenceChunk(
    db,
    body,
    body.observed_at,
    plan,
    first.next_cursor,
  );

  assert.equal(LIKES_WRITE_TRACK_LIMIT, 24);
  assert.equal(first.itemsWritten, 24);
  assert.equal(first.next_cursor, 24);
  assert.equal(first.likes_write_complete, false);
  assert.equal(firstStatementCount, 24);
  assert.deepEqual(firstBatchSizes, [11, 11, 2]);
  assert.equal(second.itemsWritten, 6);
  assert.equal(second.next_cursor, null);
  assert.equal(second.likes_write_complete, true);
  assert.equal(batches.flat().length, 30);
});

test('observation writes are idempotent for at-least-once redelivery', async () => {
  const body = queueBody(1);
  const sql = [];
  const state = {
    firsts: [],
    alls: [],
    runs: [],
    first() { return null; },
    all() { return { results: [] }; },
  };
  const db = {
    prepare(text) {
      sql.push(text);
      return statement(text, state);
    },
    async batch(statements) {
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  const key = `isrc:${body.data.tracks[0].isrc}`;
  await commitQueueLikesPersistenceChunk(db, body, body.observed_at, {
    likes_changed: true,
    complete_likes: true,
    stale_current: false,
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    structural_hash: 'structure-hash',
    likes_hash: 'new-likes-hash',
    current_track_keys: [key],
    observation_keys: [key],
    migration_keys: [],
    queue_item_positions: [0],
  });

  assert.equal(sql.some((text) => text.includes(
    'ON CONFLICT(observed_at,station_id,track_key) DO UPDATE SET',
  )), true);
});

test('likes plan and write stages preserve durable ordering through the same Queue', async () => {
  const body = queueBody(30);
  const sent = [];
  const plan = {
    likes_changed: true,
    complete_likes: true,
    stale_current: false,
    track_count: 30,
    needs_write: true,
  };
  const planned = await processOptimizedQueueLikesTask({ DB: { prepare() {} } }, body, {
    prepareQueueLikesPersistence: async () => plan,
    sendPersistenceContinuation: async (message) => { sent.push(message); },
  });

  assert.equal(planned.likes_write_deferred, true);
  assert.equal(sent[0].stage, QUEUE_STAGE_LIKES_WRITE);
  assert.equal(sent[0].likes_cursor, 0);
  assert.equal(sent[0].likes_plan, plan);

  const writeBody = sent.shift();
  const firstWrite = await processOptimizedQueueLikesTask({ DB: { prepare() {} } }, writeBody, {
    commitQueueLikesPersistenceChunk: async () => ({
      likesChanged: true,
      next_cursor: 24,
      likes_write_complete: false,
    }),
    sendPersistenceContinuation: async (message) => { sent.push(message); },
  });
  assert.equal(firstWrite.likes_write_deferred, true);
  assert.equal(sent[0].stage, QUEUE_STAGE_LIKES_WRITE);
  assert.equal(sent[0].likes_cursor, 24);

  const finalWrite = await processOptimizedQueueLikesTask({ DB: { prepare() {} } }, sent.shift(), {
    commitQueueLikesPersistenceChunk: async () => ({
      likesChanged: true,
      next_cursor: null,
      likes_write_complete: true,
    }),
    sendPersistenceContinuation: async (message) => { sent.push(message); },
  });
  assert.equal(finalWrite.likes_write_deferred, false);
  assert.equal(finalWrite.finalization_deferred, true);
  assert.equal(sent[0].stage, 'finalize');
});

test('optimized production entry routes likes-write without invoking the legacy handler', async () => {
  const body = {
    ...queueBody(1),
    stage: QUEUE_STAGE_LIKES_WRITE,
    likes_plan: { track_count: 1 },
    likes_cursor: 0,
  };
  let acked = false;
  let retried = false;
  const sent = [];
  await processPersistenceBatch({
    messages: [{
      body,
      ack() { acked = true; },
      retry() { retried = true; },
    }],
  }, {
    DB: { prepare() {} },
  }, {
    commitQueueLikesPersistenceChunk: async () => ({
      likesChanged: false,
      next_cursor: null,
      likes_write_complete: true,
    }),
    sendPersistenceContinuation: async (message) => { sent.push(message); },
  });

  assert.equal(acked, true);
  assert.equal(retried, false);
  assert.equal(sent[0].stage, 'finalize');
});
