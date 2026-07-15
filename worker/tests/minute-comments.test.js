import assert from 'node:assert/strict';
import test from 'node:test';

import {
  minuteCommentTaskId,
  runMinuteCommentTasks,
  saveMinuteCommentTask,
} from '../src/minute-comments.js';

test('minute comment task ids are stable and source-job scoped', () => {
  assert.equal(minuteCommentTaskId('minute-fact:10:120000'), 'minute-comments:minute-fact:10:120000');
  assert.equal(minuteCommentTaskId(''), 'minute-comments:');
});

test('minute comment task is persisted before the fact receipt can be saved', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      calls.push(`prepare:${sql.split('\n')[0]}`);
      return {
        bind(...params) { this.params = params; return this; },
        async run() {
          calls.push('run');
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch(statements) {
      calls.push(`batch:${statements.length}`);
      return statements.map(() => ({ success: true }));
    },
  };
  const result = await saveMinuteCommentTask({ MINUTE_DB: db }, {
    jobId: 'minute-fact:10:120000',
    payload: {
      observedAt: 123_456,
      snapshot: { channel_id: 10, station_id: 5 },
      queue: { tracks: [] },
      comments: {},
    },
    options: { collectComments: true },
  });

  assert.equal(result.created, true);
  assert.equal(calls.includes('batch:2'), true);
  assert.equal(calls.at(-1), 'run');
});

test('comment task collects with source DB and requeues an idempotent correction', async () => {
  const calls = [];
  let corrected = null;
  const env = { BUDDIES_DB: {}, MINUTE_DB: {} };
  const summary = await runMinuteCommentTasks(env, {
    now: () => 200_000,
    claim: async () => [{
      task_id: 'minute-comments:minute-fact:10:120000',
      source_job_id: 'minute-fact:10:120000',
      station_id: 5,
      observed_at: 123_456,
      attempts: 1,
      payload_json: JSON.stringify({
        payload_version: 1,
        observedAt: 123_456,
        snapshot: { channel_id: 10, station_id: 5 },
        queue: { tracks: [] },
        comments: {},
        rebuild: null,
      }),
    }],
    loadState: async (sourceEnv) => {
      assert.strictEqual(sourceEnv.DB, env.BUDDIES_DB);
      return { stationId: 5, authToken: 'token', deviceUid: 'device' };
    },
    collect: async (_env, state) => {
      assert.equal(state.stationId, 5);
      calls.push('collect');
      return { commentsSaved: 2, degraded: false, commentTotal: 20, commentTotalKnown: true };
    },
    loadFacts: async () => ({ commentCount: 2, commentTotal: 20 }),
    enqueue: async (_env, payload, options) => {
      corrected = { payload, options };
      calls.push('enqueue');
      return { enqueued: true };
    },
    complete: async () => { calls.push('complete'); },
  });

  assert.deepEqual(summary, { skipped: false, claimed: 1, completed: 1, failed: 0, dead: 0 });
  assert.deepEqual(calls, ['collect', 'enqueue', 'complete']);
  assert.equal(corrected.payload.comments.commentCount, 2);
  assert.equal(corrected.payload.comments.commentTotal, 20);
  assert.deepEqual(corrected.options, {
    jobKind: 'comment-correction',
    jobPriority: 10,
    requeueCompleted: true,
  });
});

test('comment task failures stay in the task queue and do not reject the minute run', async () => {
  let failed = null;
  const summary = await runMinuteCommentTasks({ BUDDIES_DB: {}, MINUTE_DB: {} }, {
    claim: async () => [{
      task_id: 'task-1',
      station_id: 5,
      observed_at: 123_456,
      attempts: 1,
      payload_json: JSON.stringify({
        payload_version: 1,
        observedAt: 123_456,
        snapshot: { channel_id: 10, station_id: 5 },
        queue: null,
        comments: {},
        rebuild: null,
      }),
    }],
    loadState: async () => ({ stationId: 5, authToken: 'token', deviceUid: 'device' }),
    collect: async () => ({ degraded: true, errorStage: 'sh_chat_history' }),
    fail: async (_env, task, error) => {
      failed = { task, message: error.message };
      return { terminal: false };
    },
  });

  assert.deepEqual(summary, { skipped: false, claimed: 1, completed: 0, failed: 1, dead: 0 });
  assert.equal(failed.task.task_id, 'task-1');
  assert.match(failed.message, /comment collection degraded/);
});
