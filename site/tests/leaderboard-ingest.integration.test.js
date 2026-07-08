import assert from 'node:assert/strict';
import test from 'node:test';

import {
  D1_LEADERBOARD_BATCH_VARIABLE_LIMIT,
  onRequestPost,
} from '../functions/api/leaderboard-ingest.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

function post(body) {
  return new Request('https://skrzk.test/api/leaderboard-ingest', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const env = (db) => ({ DB: db, INGEST_SECRET: 'test-key' });

test('weekly leaderboard ingest splits D1 batches by bind count', async () => {
  const db = new FakeD1Database();
  const response = await onRequestPost({
    request: post({
      ranking_date: '2026-07-08',
      ranking_type: '週間チャンネル順位',
      source: 'test-source',
      observed_at: 1_751_500_300_000,
      accounts: Array.from({ length: 30 }, (_, index) => ({
        rank: index + 1,
        handle: `account-${index + 1}`,
        account_id: 1000 + index,
        leaderboard_movement: null,
        raw: { rank: index + 1, handle: `account-${index + 1}` },
      })),
    }),
    env: env(db),
  });
  const body = await responseJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, true);
  assert.equal(body.rows, 30);
  assert.ok(db.batches.length > 1);
  for (const batch of db.batches) {
    const bindCount = batch.reduce((sum, statement) => sum + statement.params.length, 0);
    assert.ok(
      bindCount <= D1_LEADERBOARD_BATCH_VARIABLE_LIMIT,
      `batch bind count ${bindCount} exceeds ${D1_LEADERBOARD_BATCH_VARIABLE_LIMIT}`,
    );
  }
});
