import assert from 'node:assert/strict';
import test from 'node:test';

import { processCommentsTask } from '../src/comments-entry.js';
import {
  minuteFactQueueMessage,
  parseMinuteFactQueueMessage,
} from '../src/minute-facts-queue.js';

function commentsTask() {
  return {
    message_type: 'stationhead-comments-task',
    message_version: 2,
    observed_at: 1_784_000_000_000,
    station_id: 123,
    auth: {
      authToken: 'token',
      deviceUid: 'device',
      tokenExpiresAt: 9_999_999_999_999,
    },
    minute_fact: minuteFactQueueMessage({
      observedAt: 1_784_000_000_000,
      snapshot: { channel_id: 10, station_id: 123 },
      queue: { tracks: [] },
    }),
  };
}

test('normal chained comments reuse the initial trusted minute parse', async () => {
  let parseCalls = 0;
  let sent = null;
  const task = commentsTask();

  const result = await processCommentsTask({}, task, {
    parseMinuteFact(body) {
      parseCalls += 1;
      return parseMinuteFactQueueMessage(body);
    },
    collectComments: async () => ({
      commentsSaved: 2,
      degraded: false,
      errorStage: null,
    }),
    loadCommentFacts: async () => ({ commentCount: 2, commentTotal: 20 }),
    sendMinuteFact: async (message) => { sent = message; },
  });

  assert.equal(parseCalls, 1);
  assert.equal(result.forwarded, true);
  assert.equal(result.job_id, task.minute_fact.job_id);
  assert.equal(sent.payload.comments.commentCount, 2);
  assert.equal(sent.payload.comments.commentTotal, 20);
  assert.equal(sent.options.collectComments, false);
});
