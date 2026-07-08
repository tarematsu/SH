import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestPost as hostIngestPost } from '../functions/api/host-ingest.js';
import { onRequestPost as ingestPost } from '../functions/api/ingest.js';
import { onRequestPost as leaderboardPost } from '../functions/api/leaderboard-ingest.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

function post(url, body, authorization = 'Bearer test-key') {
  return new Request(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const env = (db) => ({ DB: db, INGEST_SECRET: 'test-key' });

test('leaderboard ingest rejects unauthorized, malformed and empty requests', async () => {
  const db = new FakeD1Database();
  const unauthorized = await leaderboardPost({
    request: post('https://skrzk.test/api/leaderboard-ingest', {}, ''),
    env: env(db),
  });
  assert.equal(unauthorized.status, 401);

  const malformed = await leaderboardPost({
    request: post('https://skrzk.test/api/leaderboard-ingest', '{'),
    env: env(db),
  });
  assert.equal(malformed.status, 400);
  assert.equal((await responseJson(malformed)).error, 'invalid JSON');

  const invalidDate = await leaderboardPost({
    request: post('https://skrzk.test/api/leaderboard-ingest', {
      ranking_date: '03/07/2026',
      accounts: [{ handle: 'sample' }],
    }),
    env: env(db),
  });
  assert.equal(invalidDate.status, 400);

  const empty = await leaderboardPost({
    request: post('https://skrzk.test/api/leaderboard-ingest', {
      ranking_date: '2026-07-03',
      accounts: [],
    }),
    env: env(db),
  });
  assert.equal(empty.status, 400);
  assert.equal(db.calls.length, 0);
});

test('leaderboard ingest normalizes, sorts and safely replaces one ranking day', async () => {
  const db = new FakeD1Database();
  const response = await leaderboardPost({
    request: post('https://skrzk.test/api/leaderboard-ingest', {
      observed_at: 1_751_500_000_000,
      ranking_date: '2026-07-03',
      source: 'integration-suite',
      collector_id: 'integration-collector',
      accounts: [
        { rank: 2, handle: 'Second', leaderboard_movement: -1 },
        { rank: 1, handle: 'First', leaderboard_movement: 3 },
        { rank: 0, handle: '' },
      ],
    }),
    env: env(db),
  });
  const body = await responseJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, true);
  assert.equal(body.rows, 2);
  assert.equal(db.batches.length, 1);
  const batch = db.batches[0];
  const deleteIndex = batch.findIndex((statement) => /DELETE FROM sh_channel_rankings/i.test(statement.sql));
  const insertIndexes = batch
    .map((statement, index) => (/INSERT INTO sh_channel_rankings/i.test(statement.sql) ? index : -1))
    .filter((index) => index >= 0);
  const fetchIndex = batch.findIndex((statement) => /INSERT INTO sh_leaderboard_fetches/i.test(statement.sql));

  assert.deepEqual(insertIndexes, [0, 1]);
  assert.equal(deleteIndex, batch.length - 1);
  assert.equal(fetchIndex, 2);
  assert.equal(batch[insertIndexes[0]].params[3], 1);
  assert.equal(batch[insertIndexes[0]].params[4], 'First');
  assert.equal(batch[insertIndexes[1]].params[3], 2);
  assert.equal(batch[insertIndexes[1]].params[4], 'Second');
  assert.match(batch[deleteIndex].sql, /json_valid\(quality_flags\)/);
});

test('queue ingest claims, snapshots and writes changed tracks in one request flow', async () => {
  const db = new FakeD1Database();
  const response = await ingestPost({
    request: post('https://skrzk.test/api/ingest', {
      type: 'queue',
      collector_id: 'integration-collector',
      observed_at: 1_751_500_100_000,
      data: {
        station_id: 3328626,
        queue_id: 41,
        start_time: 1_751_500_000_000,
        is_paused: false,
        tracks: [{
          position: 0,
          queue_track_id: 100,
          stationhead_track_id: 200,
          spotify_id: 'spotify-1',
          duration_ms: 180_000,
          bite_count: 15,
          raw: { source: 'integration' },
        }],
      },
    }),
    env: env(db),
  });
  const body = await responseJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, true);
  assert.equal(body.duplicate, false);
  assert.equal(body.queue_inspected, true);
  assert.equal(body.queue_items_written, 1);
  assert.equal(body.like_observations_written, 1);
});
