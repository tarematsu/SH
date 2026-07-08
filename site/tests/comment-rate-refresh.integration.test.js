import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMENT_VELOCITY_UPDATE_SQL,
  D1_COMMENT_BATCH_VARIABLE_LIMIT,
  saveCommentCounts,
} from '../functions/lib/comment-counts.js';
import { FakeD1Database } from './helpers/fake-d1.js';

test('comment rate refreshes when a poll has no new comments', async () => {
  const db = new FakeD1Database();
  const observedAt = 1_751_500_360_000;

  const result = await saveCommentCounts(db, observedAt, {
    station_id: 3328626,
    comments: [],
  });
  const updates = db.callsMatching(/UPDATE sh_channel_snapshots/i, 'run');

  assert.equal(result.accepted, 0);
  assert.equal(result.skipped, true);
  assert.equal(result.velocityUpdated, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sql, COMMENT_VELOCITY_UPDATE_SQL);
});

test('comment rate update targets the latest snapshot only', () => {
  assert.match(COMMENT_VELOCITY_UPDATE_SQL, /ORDER BY observed_at DESC,id DESC LIMIT 1/);
  assert.match(COMMENT_VELOCITY_UPDATE_SQL, /SELECT SUM\(comment_count\)/);
});

test('comment count writes split D1 batches by bind count', async () => {
  const db = new FakeD1Database();
  const observedAt = 1_751_500_360_000;

  const result = await saveCommentCounts(db, observedAt, {
    station_id: 3328626,
    comments: Array.from({ length: 50 }, (_, index) => ({
      id: 10_000 + index,
      station_id: 3328626,
      chat_time_ms: observedAt + index * 60_000,
    })),
  });

  assert.equal(result.accepted, 50);
  assert.ok(db.batches.length > 1);
  for (const batch of db.batches) {
    const bindCount = batch.reduce((sum, statement) => sum + statement.params.length, 0);
    assert.ok(
      bindCount <= D1_COMMENT_BATCH_VARIABLE_LIMIT,
      `batch bind count ${bindCount} exceeds ${D1_COMMENT_BATCH_VARIABLE_LIMIT}`,
    );
  }
});
