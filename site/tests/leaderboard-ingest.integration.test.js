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

test('weekly leaderboard replacement upserts before stale cleanup', async () => {
  const db = new FakeD1Database();
  const response = await onRequestPost({
    request: post({
      ranking_date: '2026-07-08',
      ranking_type: '週間チャンネル順位',
      source: 'test-source',
      observed_at: 1_751_500_300_000,
      accounts: [
        { rank: 1, handle: 'first', raw: { rank: 1, handle: 'first' } },
        { rank: 2, handle: 'second', raw: { rank: 2, handle: 'second' } },
      ],
    }),
    env: env(db),
  });
  const body = await responseJson(response);
  const orderedSql = db.batches.flat().map((statement) => statement.sql);
  const firstRankingDelete = orderedSql.findIndex((sql) => /DELETE FROM sh_channel_rankings/i.test(sql));
  const firstRankingInsert = orderedSql.findIndex((sql) => /INSERT INTO sh_channel_rankings/i.test(sql));

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(firstRankingInsert >= 0);
  assert.ok(firstRankingDelete > firstRankingInsert);
  assert.match(orderedSql[firstRankingDelete], /json_valid\(quality_flags\)/);
  assert.match(orderedSql[firstRankingDelete], /json_extract\(quality_flags, '\$\.source_hash'\)/);
});

test('duplicate weekly leaderboard claims still replay idempotent writes', async () => {
  const db = new FakeD1Database([
    {
      kind: 'first',
      matcher: /FROM sh_ingest_claims WHERE dedupe_key=\?/,
      result: {
        collector_id: 'test-source',
        collector_kind: 'local',
        source_priority: 70,
        observed_at: 1_751_500_300_000,
        payload_hash: 'repeat-hash',
        first_seen_at: 1_751_500_300_000,
      },
    },
  ]);
  const response = await onRequestPost({
    request: post({
      ranking_date: '2026-07-08',
      ranking_type: '週間チャンネル順位',
      source: 'test-source',
      source_hash: 'repeat-hash',
      observed_at: 1_751_500_300_000,
      accounts: [
        { rank: 1, handle: 'first', raw: { rank: 1, handle: 'first' } },
      ],
    }),
    env: env(db),
  });
  const body = await responseJson(response);
  const writtenSql = db.batches.flat().map((statement) => statement.sql).join('\n');

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, false);
  assert.equal(body.duplicate, true);
  assert.equal(body.saved, true);
  assert.match(writtenSql, /INSERT INTO sh_channel_rankings/);
  assert.match(writtenSql, /INSERT INTO sh_leaderboard_fetches/);
});
