import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetCommentCountRuntimeState,
  saveCommentCounts,
} from '../functions/lib/comment-counts.js';
import { normalizeComments } from '../../worker/src/shared-utils.js';
import { FakeD1Database } from './helpers/fake-d1.js';

test('comment_id-only payloads normalize to a stable numeric id', () => {
  const comments = normalizeComments({
    chats: [{
      comment_id: 123,
      text: 'hello',
      account: { id: 7, handle: 'listener' },
    }],
  }, 999);

  assert.equal(comments.length, 1);
  assert.equal(comments[0].comment_id, 123);
  assert.equal(comments[0].id, 123);
  assert.equal(comments[0].station_id, 999);
});

test('comment counters accept comment_id and reuse the runtime cursor', async () => {
  const db = new FakeD1Database();
  resetCommentCountRuntimeState(db);
  const data = {
    station_id: 999,
    comments: [{ comment_id: 123, station_id: 999, chat_time_ms: 1_751_500_000_000 }],
  };

  const first = await saveCommentCounts(db, 1_751_500_010_000, data);
  const second = await saveCommentCounts(db, 1_751_500_020_000, data);

  assert.equal(first.accepted, 1);
  assert.equal(first.last_comment_id, 123);
  assert.equal(second.accepted, 0);
  assert.equal(second.cursorHit, true);
  assert.equal(db.callsMatching(/FROM sh_comment_state/, 'first').length, 1);
  assert.equal(db.batches.length, 1);
});

test('known collector cursor skips D1 when chat history is unchanged', async () => {
  const db = new FakeD1Database();
  const result = await saveCommentCounts(db, 1_751_500_010_000, {
    station_id: 999,
    known_last_comment_id: 200,
    comments: [{ id: 199, station_id: 999 }],
  });

  assert.equal(result.accepted, 0);
  assert.equal(result.last_comment_id, 200);
  assert.equal(result.cursorHit, true);
  assert.equal(db.calls.length, 0);
});
