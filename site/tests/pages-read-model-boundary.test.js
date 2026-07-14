import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { onRequestPost as ingestPost } from '../functions/api/ingest.js';
import { onRequestPost as hostIngestPost } from '../functions/api/host-ingest.js';
import { onRequest as metadataRefresh } from '../functions/api/track-metadata-refresh.js';
import {
  CHANNEL_READ_MODEL_SQL,
  COLLECTOR_READ_MODEL_SQL,
  QUEUE_READ_MODEL_SQL,
  presentationFromRow,
  queueFromReadModel,
} from '../functions/lib/public-read-model.js';
import { normalizePlaybackTrack } from '../functions/lib/playback.js';

test('FACTS read-model SQL never references the private buddies tables', () => {
  for (const sql of [CHANNEL_READ_MODEL_SQL, QUEUE_READ_MODEL_SQL, COLLECTOR_READ_MODEL_SQL]) {
    assert.doesNotMatch(sql, /sh_channel_snapshots|sh_queue_items|sh_track_metadata|sh_worker_collector_state/);
  }
});

test('Pages has no binding to the private buddies database', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.d1_databases.some(({ database_name }) => database_name === 'stationhead-buddies'), false);
  assert.equal(config.d1_databases.some(({ database_id }) => database_id === 'f361aae0-05f0-42bc-8784-77100e80133d'), false);
});

test('queue read model accepts both an array and an object envelope', () => {
  const base = { station_id: 3, queue_id: 4, start_time: 5, observed_at: 6, is_paused: 0 };
  const direct = queueFromReadModel({ ...base, queue_json: '[{"title":"A"}]' });
  const enveloped = queueFromReadModel({ ...base, queue_json: '{"queue":[{"title":"B"}]}' });
  assert.equal(direct.queue[0].title, 'A');
  assert.equal(enveloped.queue[0].title, 'B');
  assert.equal(direct.queue[0].station_id, 3);
  assert.equal(direct.latestQueue.start_time, 5);
});

test('queue read-model presentation fields survive playback normalization', () => {
  const { queue } = queueFromReadModel({
    station_id: 3,
    queue_id: 4,
    start_time: 5,
    observed_at: 6,
    is_paused: 0,
    queue_json: JSON.stringify([{ title: 'Song', artist: 'Artist', thumbnail_url: 'https://example.test/a.jpg' }]),
  });
  assert.deepEqual(normalizePlaybackTrack(queue[0], 0, { currentIndex: -1, progressMs: 0 }), {
    spotify_id: null,
    duration_ms: 0,
    title: 'Song',
    artist: 'Artist',
    thumbnail_url: 'https://example.test/a.jpg',
  });
});

test('presentation read model rejects malformed JSON without failing the page', () => {
  assert.deepEqual(presentationFromRow({ presentation_json: '{bad' }), {});
});

test('Pages write paths are retired with non-cacheable 404 responses', async () => {
  for (const response of [ingestPost(), hostIngestPost(), metadataRefresh()]) {
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
