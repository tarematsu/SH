import assert from 'node:assert/strict';
import test from 'node:test';

import {
  processCommentsForwardTask,
  processCommentsTask,
} from '../src/comments-entry.js';
import { minuteFactQueueMessage } from '../src/minute-facts-queue.js';
import { processTrackMetadataTask } from '../src/track-metadata-entry.js';

function minuteFact() {
  return minuteFactQueueMessage({
    observedAt: 1_784_000_000_000,
    snapshot: { channel_id: 10, station_id: 20 },
    queue: { tracks: [] },
  });
}

test('comment collection hands forwarding to a separate Queue invocation', async () => {
  const sent = [];
  const task = {
    message_type: 'stationhead-comments-task',
    message_version: 2,
    observed_at: 1_784_000_000_000,
    station_id: 20,
    auth: {},
    minute_fact: minuteFact(),
  };
  const result = await processCommentsTask({
    COMMENTS_QUEUE: {
      async send(body, options) { sent.push({ body, options }); },
    },
  }, task, {
    collectComments: async () => ({ commentsSaved: 3, degraded: false, errorStage: null }),
  });

  assert.equal(result.forward_deferred, true);
  assert.equal(result.forwarded, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.message_type, 'stationhead-comments-forward');
  assert.equal(sent[0].body.minute_fact, task.minute_fact);
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

test('read-model hydration and writes run as separate metadata stages', async () => {
  const enqueued = [];
  const readModel = { channel: { channel_id: 10, observed_at: 20 } };
  const hydration = await processTrackMetadataTask({}, {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'read-model-hydration',
    job_id: 'read-model:10:20',
    read_model: readModel,
  }, {
    prepareReadModelForWrite: async (_env, value) => ({ ...value, prepared: true }),
    enqueueReadModelWrite: async (value, body) => enqueued.push({ value, body }),
  });
  let written = null;
  const write = await processTrackMetadataTask({}, {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'read-model-write',
    job_id: 'read-model:10:20',
    read_model: enqueued[0].value,
  }, {
    writePreparedReadModel: async (_env, value) => { written = value; },
  });

  assert.equal(hydration.pending, true);
  assert.equal(enqueued[0].value.prepared, true);
  assert.equal(write.pending, false);
  assert.equal(written.prepared, true);
});
