import assert from 'node:assert/strict';
import test from 'node:test';

import {
  processCommentsForwardTask,
  processCommentsPersistTask,
  processCommentsTask,
} from '../src/comments-entry.js';
import { processIngestFinalizeTask } from '../src/ingest-finalize-entry.js';
import { minuteFactQueueMessage } from '../src/minute-facts-queue.js';
import { processTrackMetadataTask } from '../src/track-metadata-entry.js';

function minuteFact() {
  return minuteFactQueueMessage({
    observedAt: 1_784_000_000_000,
    snapshot: { channel_id: 10, station_id: 20 },
    queue: { tracks: [] },
  });
}

function commentsTask() {
  return {
    message_type: 'stationhead-comments-task',
    message_version: 2,
    observed_at: 1_784_000_000_000,
    station_id: 20,
    auth: {
      authToken: 'token',
      deviceUid: 'device',
      tokenExpiresAt: 9_999_999_999_999,
    },
    minute_fact: minuteFact(),
  };
}

test('comment collection, persistence and forwarding use separate Queue invocations', async () => {
  const sent = [];
  const env = {
    COMMENTS_QUEUE: {
      async send(body, options) { sent.push({ body, options }); },
    },
  };
  const task = commentsTask();
  const fetched = await processCommentsTask(env, task, {
    fetchComments: async () => ({
      comments: [{ comment_id: 1 }, { comment_id: 2 }, { comment_id: 3 }],
      rawMeta: { next: 'cursor' },
      skipped: false,
    }),
  });

  assert.equal(fetched.persist_deferred, true);
  assert.equal(fetched.forwarded, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.message_type, 'stationhead-comments-persist');
  assert.equal(sent[0].body.minute_fact, task.minute_fact);
  assert.equal(sent[0].body.collected.comments.length, 3);

  const persisted = await processCommentsPersistTask(env, sent.shift().body, {
    persistComments: async () => ({ commentsSaved: 3, degraded: false, errorStage: null }),
  });
  assert.equal(persisted.forward_deferred, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.message_type, 'stationhead-comments-forward');
  assert.equal(sent[0].body.comments.commentsSaved, 3);
});

test('comment forwarding performs fact lookup and durable minute handoff separately', async () => {
  let forwarded = null;
  const result = await processCommentsForwardTask({}, {
    message_type: 'stationhead-comments-forward',
    message_version: 1,
    observed_at: 1_784_000_000_000,
    station_id: 20,
    minute_fact: minuteFact(),
    comments: { commentsSaved: 3, degraded: false },
  }, {
    loadCommentFacts: async () => ({ commentCount: 3, commentTotal: 9 }),
    sendMinuteFact: async (body) => { forwarded = body; },
  });

  assert.equal(result.forwarded, true);
  assert.equal(forwarded.payload.comments.commentCount, 3);
  assert.equal(forwarded.payload.comments.commentTotal, 9);
});

test('read-model hydration, preservation and writes run as separate metadata stages', async () => {
  const enqueued = [];
  const readModel = { channel: { channel_id: 10, observed_at: 20 } };
  const dependencies = {
    hydrateReadModelMetadata: async (_env, value) => ({ ...value, hydrated: true }),
    preserveReadModelForWrite: async (_env, value) => ({ ...value, preserved: true }),
    enqueueReadModelStage: async (task, value, body) => enqueued.push({ task, value, body }),
  };
  const hydration = await processTrackMetadataTask({}, {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'read-model-hydration',
    job_id: 'read-model:10:20',
    read_model: readModel,
  }, dependencies);
  assert.equal(hydration.next_task, 'read-model-preserve');
  assert.equal(enqueued[0].value.hydrated, true);

  const preservation = await processTrackMetadataTask({}, {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: enqueued[0].task,
    job_id: 'read-model:10:20',
    read_model: enqueued[0].value,
  }, dependencies);
  assert.equal(preservation.next_task, 'read-model-write');
  assert.equal(enqueued[1].value.preserved, true);

  let written = null;
  const write = await processTrackMetadataTask({}, {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: enqueued[1].task,
    job_id: 'read-model:10:20',
    read_model: enqueued[1].value,
  }, {
    writePreparedReadModel: async (_env, value) => { written = value; },
  });

  assert.equal(write.pending, false);
  assert.equal(written.hydrated, true);
  assert.equal(written.preserved, true);
});

test('ingest finalization preserves collector state before read-model handoff', async () => {
  const calls = [];
  const state = {
    authToken: 'token',
    deviceUid: 'device',
    lastRunAt: 20,
    lastSuccessAt: 21,
  };
  const readModel = { message_type: 'stationhead-read-model', job_id: 'read-model:10:20' };
  const result = await processIngestFinalizeTask({ DB: {} }, {
    message_type: 'stationhead-ingest-finalize',
    message_version: 1,
    observed_at: 20,
    channel_id: 10,
    collector_state: state,
    read_model: readModel,
  }, {
    saveCollectorState: async (_env, value) => {
      calls.push('state');
      assert.equal(value, state);
      return { accepted: true };
    },
    sendReadModel: async (value) => {
      calls.push('read-model');
      assert.equal(value, readModel);
    },
  });

  assert.deepEqual(calls, ['state', 'read-model']);
  assert.equal(result.state_accepted, true);
});
