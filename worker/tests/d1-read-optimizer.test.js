import test from 'node:test';
import assert from 'node:assert/strict';

import { rewriteDuplicateVelocityRead, withDuplicateVelocityReadRemoved } from '../src/d1-read-optimizer.js';

const SNAPSHOT_SQL = `INSERT INTO sh_channel_snapshots (comment_velocity) VALUES ((
      SELECT COALESCE(SUM(comment_count),0) FROM sh_comment_minute_counts
      WHERE station_id=? AND bucket_start>=? AND bucket_start<=?
    ))`;

test('snapshot velocity SUM is replaced when comments are collected later', () => {
  const rewritten = rewriteDuplicateVelocityRead(SNAPSHOT_SQL, true);
  assert.equal(rewritten.includes('sh_comment_minute_counts'), false);
  assert.equal(rewritten.includes('SELECT 0 FROM'), true);
  assert.equal((rewritten.match(/\?/g) || []).length, 3);
});

test('snapshot velocity SUM remains for chat-disabled paths', () => {
  assert.equal(rewriteDuplicateVelocityRead(SNAPSHOT_SQL, false), SNAPSHOT_SQL);
});

test('DB proxy rewrites only scheduled snapshot prepare calls', () => {
  const prepared = [];
  const db = {
    prepare(sql) {
      prepared.push(sql);
      return { sql };
    },
  };
  const env = withDuplicateVelocityReadRemoved({ DB: db, CHAT_LIMIT: 50 });
  env.DB.prepare(SNAPSHOT_SQL);
  env.DB.prepare('SELECT 1');
  assert.equal(prepared[0].includes('sh_comment_minute_counts'), false);
  assert.equal(prepared[1], 'SELECT 1');
});
