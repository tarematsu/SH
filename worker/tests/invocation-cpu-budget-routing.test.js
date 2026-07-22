import assert from 'node:assert/strict';
import test from 'node:test';

import { processPersistenceBatch } from '../src/persist-channel-optimized-entry.js';
import { processBudgetedQueueStructureTask } from '../src/persist-structure-budget-entry.js';
import {
  LIVE_DERIVE_QUEUE_NAME,
  processMinutePipelineBatch,
} from '../src/minute-pipeline-entry.js';

function queueMessage(body) {
  const events = [];
  return {
    body,
    events,
    ack() { events.push('ack'); },
    retry() { events.push('retry'); },
  };
}

function queueBody(stage = 'persist', trackCount = 2) {
  return {
    message_type: 'stationhead-persistence-task',
    message_version: 1,
    task: 'queue',
    stage,
    observed_at: 123_456,
    collector_id: 'cloudflare-worker',
    data: {
      station_id: 20,
      queue_id: 30,
      start_time: 40,
      total_track_count: trackCount,
      materialized_track_count: trackCount,
      tracks: Array.from({ length: trackCount }, (_, position) => ({
        position,
        spotify_id: `sp${position}`,
        isrc: `JPTEST${String(position).padStart(6, '0')}`,
        bite_count: position,
      })),
    },
    analysis: {
      structural_hash: 'structure',
      likes_hash: 'likes',
      likes: { complete: true, payload: [] },
    },
  };
}

test('runtime closes live revision continuations without loading the derive graph', async () => {
  const calls = [];
  const message = queueMessage({
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'revision-materialize',
    revision: {
      sparse: true,
      rebuild: false,
      revision_id: 77,
    },
  });
  const db = {
    prepare(sql) {
      calls.push({ sql, args: [] });
      return {
        bind(...args) { calls.at(-1).args = args; return this; },
        async run() { return { meta: { changes: 1 } }; },
      };
    },
  };

  await processMinutePipelineBatch({
    queue: LIVE_DERIVE_QUEUE_NAME,
    messages: [message],
  }, {
    HISTORICAL_REBUILD_ENABLED: false,
    MINUTE_DB: db,
  });

  assert.deepEqual(message.events, ['ack']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /status='complete'/);
  assert.equal(calls[0].args[1], 77);
});

test('ingest routes structure preparation without loading likes or legacy handlers', async () => {
  const message = queueMessage(queueBody('persist'));
  const sent = [];
  await processPersistenceBatch({ messages: [message] }, {
    DB: { prepare() {} },
  }, {
    async prepareQueueStructurePersistence() {
      return { structure_changed: false };
    },
    async sendPersistenceContinuation(body) {
      sent.push(body);
    },
  });

  assert.deepEqual(message.events, ['ack']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, 'likes');
});

test('ingest routes unchanged likes directly to finalization in budget mode', async () => {
  const message = queueMessage(queueBody('likes'));
  const sent = [];
  let receivedDb = null;
  const db = { prepare() {} };
  await processPersistenceBatch({ messages: [message] }, { DB: db }, {
    async prepareQueueLikesPersistence(activeDb) {
      receivedDb = activeDb;
      return {
        likes_changed: false,
        track_count: 2,
        needs_write: false,
      };
    },
    async sendPersistenceContinuation(body) {
      sent.push(body);
    },
  });

  assert.equal(typeof receivedDb?.prepare, 'function');
  assert.deepEqual(message.events, ['ack']);
  assert.equal(sent[0].stage, 'finalize');
});

test('structure writes are split into at most twelve positions per invocation', async () => {
  const body = queueBody('structure-write', 30);
  body.structure_plan = {
    structure_changed: true,
    write_positions: Array.from({ length: 30 }, (_, index) => index),
    all_positions: Array.from({ length: 30 }, (_, index) => index),
    stale_current: false,
    snapshot_required: true,
  };
  body.structure_cursor = 0;
  const committed = [];
  const sent = [];
  const result = await processBudgetedQueueStructureTask({
    DB: { prepare() {} },
  }, body, {
    async commitQueueStructurePersistence(_db, _body, _observedAt, plan) {
      committed.push(plan);
      return { structureChanged: true, itemsWritten: plan.write_positions.length };
    },
    async sendPersistenceContinuation(message) {
      sent.push(message);
    },
  });

  assert.deepEqual(committed[0].write_positions, Array.from({ length: 12 }, (_, index) => index));
  assert.equal(committed[0].stale_current, true);
  assert.equal(committed[0].snapshot_required, false);
  assert.equal(result.next_cursor, 12);
  assert.equal(sent[0].stage, 'structure-write');
  assert.equal(sent[0].structure_cursor, 12);
});
