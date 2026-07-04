import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestPost as hostIngestPost } from '../functions/api/host-ingest.js';
import { onRequestPost as ingestPost } from '../functions/api/ingest.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

function post(body) {
  return new Request('https://skrzk.test/api/ingest', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const env = (db) => ({ DB: db, INGEST_SECRET: 'test-key' });

test('primary comments update aggregate counters without storing raw comment rows', async () => {
  const db = new FakeD1Database();
  const response = await ingestPost({
    request: post({
      type: 'comments',
      observed_at: 1_751_500_300_000,
      data: {
        station_id: 3328626,
        comments: [
          { id: 101, station_id: 3328626, chat_time_ms: 1_751_500_280_000, raw: { id: 101, text: 'one' } },
          { id: 102, station_id: 3328626, chat_time_ms: 1_751_500_290_000, raw: { id: 102, text: 'two' } },
        ],
      },
    }),
    env: env(db),
  });
  const body = await responseJson(response);
  const sql = db.batches.flat().map((entry) => entry.sql).join('\n');

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, 2);
  assert.match(sql, /sh_comment_minute_counts/);
  assert.match(sql, /sh_comment_daily_counts/);
  assert.match(sql, /sh_comment_state/);
  assert.equal(db.callsMatching(/INSERT INTO sh_comments\b/i).length, 0);
});

test('solo comments update aggregate counters without storing host comment bodies', async () => {
  const db = new FakeD1Database();
  const response = await hostIngestPost({
    request: post({
      type: 'solo_comments',
      observed_at: 1_751_500_300_000,
      data: {
        session_id: 9001,
        station_id: 3328626,
        comments: [
          { comment_id: 201, station_id: 3328626, chat_time_ms: 1_751_500_290_000, raw: { comment_id: 201 } },
        ],
      },
    }),
    env: env(db),
  });
  const body = await responseJson(response);
  const sql = db.batches.flat().map((entry) => entry.sql).join('\n');

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, 1);
  assert.match(sql, /sh_solo_activity_minutes/);
  assert.match(sql, /sh_solo_activity_days/);
  assert.match(sql, /sh_solo_activity_state/);
  assert.equal(db.callsMatching(/INSERT INTO sh_host_comments\b/i).length, 0);
});
