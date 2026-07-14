import assert from 'node:assert/strict';
import test from 'node:test';

import { hostIngestInternal as hostIngestPost } from '../functions/api/host-ingest.js';
import { ingestInternal as ingestPost } from '../functions/api/ingest.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

function post(url, body, authorization = 'Bearer test-key') {
  return new Request(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const env = (db) => ({ DB: db, OTHER_DB: db, INGEST_SECRET: 'test-key' });

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
          isrc: 'JPABC1234567',
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
  assert.equal(db.callsMatching(/INSERT INTO sh_ingest_claims/, 'run').length, 1);
  assert.equal(db.callsMatching(/INSERT INTO sh_queue_snapshots/, 'run').length, 1);
  assert.equal(db.callsMatching(/INSERT INTO sh_queue_items/, 'run').length, 1);
  assert.equal(db.callsMatching(/INSERT INTO sh_track_like_current/, 'run').length, 1);
  assert.equal(db.callsMatching(/INSERT INTO sh_track_like_observations/, 'run').length, 1);
});

test('queue ingest keeps accepting checkpoint writes without forcing duplicate claims', async () => {
  const observedAt = 1_751_500_160_000;
  const db = new FakeD1Database();
  const response = await ingestPost({
    request: post('https://skrzk.test/api/ingest', {
      type: 'queue',
      collector_id: 'integration-collector',
      observed_at: observedAt,
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
          isrc: 'JPABC1234567',
          duration_ms: 180_000,
          bite_count: 15,
        }],
      },
    }),
    env: env(db),
  });
  const body = await responseJson(response);

  assert.equal(body.accepted, true);
  assert.equal(body.duplicate, false);
  assert.equal(body.queue_inspected, true);
  assert.equal(body.queue_items_written, 1);
  assert.equal(body.like_observations_written, 1);
  assert.equal(db.callsMatching(/sh_ingest_claims/, 'run').length, 1);
  assert.equal(db.callsMatching(/INSERT INTO sh_queue_items/, 'run').length, 1);
  assert.equal(db.callsMatching(/INSERT INTO sh_track_like_observations/, 'run').length, 1);
});

test('host snapshot ingest creates a claim and persists one session observation', async () => {
  const db = new FakeD1Database();
  const response = await hostIngestPost({
    request: post('https://skrzk.test/api/host-ingest', {
      type: 'solo_station_snapshot',
      collector_id: 'integration-collector',
      observed_at: 1_751_500_200_000,
      data: {
        session_id: 9001,
        station_id: 3328626,
        broadcast_id: 81,
        is_broadcasting: true,
        status: 'live',
        listener_count: 123,
        total_listens: 456,
        handle: 'sakurazaka46jp',
      },
    }),
    env: env(db),
  });
  const body = await responseJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, true);
  assert.equal(db.callsMatching(/INSERT INTO sh_ingest_claims/, 'run').length, 1);
  assert.equal(db.callsMatching(/INSERT INTO sh_host_station_snapshots/, 'run').length, 1);
});

test('important websocket events are stored while unknown events are intentionally ignored', async () => {
  const importantDb = new FakeD1Database();
  const important = await hostIngestPost({
    request: post('https://skrzk.test/api/host-ingest', {
      type: 'solo_ws_event',
      observed_at: 1_751_500_300_000,
      data: { session_id: 9001, station_id: 3328626, event: 'listenerCount', data: { count: 321 } },
    }),
    env: env(importantDb),
  });
  assert.equal((await responseJson(important)).stored, true);
  assert.equal(importantDb.callsMatching(/INSERT INTO sh_host_raw_events/, 'run').length, 1);

  const ignoredDb = new FakeD1Database();
  const ignored = await hostIngestPost({
    request: post('https://skrzk.test/api/host-ingest', {
      type: 'solo_ws_event',
      observed_at: 1_751_500_305_000,
      data: { session_id: 9001, station_id: 3328626, event: 'typingIndicator', data: {} },
    }),
    env: env(ignoredDb),
  });
  assert.equal((await responseJson(ignored)).stored, false);
  assert.equal(ignoredDb.callsMatching(/INSERT INTO sh_host_raw_events/).length, 0);
});
