import assert from 'node:assert/strict';
import test from 'node:test';

import { ingestRawCollection } from '../src/ingest-channel-optimized-entry.js';
import { collectRawChannel } from '../src/raw-collector-entry.js';
import {
  processRawAnalysisStage,
  processRawMaterializeStage,
  processRawNormalizeStage,
  RAW_ANALYSIS_MESSAGE,
  RAW_MATERIALIZE_MESSAGE,
} from '../src/raw-collection-preparation.js';

function channelBody() {
  return JSON.stringify({
    id: 10,
    alias: 'buddies',
    current_station_id: 123,
    current_station: {
      id: 123,
      queue: {
        id: 456,
        start_time: 1_784_000_000_000,
        is_paused: false,
        queue_tracks: [{
          id: 11,
          track: {
            id: 22,
            spotify_id: 'track',
            isrc: 'JPTEST000001',
            bite_count: 4,
            title: 'Song',
            artist: { name: 'Artist' },
            duration_ms: 180_000,
          },
        }],
      },
    },
  });
}

function rawTask(body = channelBody()) {
  return {
    message_type: 'stationhead-raw-channel',
    message_version: 1,
    observed_at: 1_784_000_000_000,
    channel_alias: 'buddies',
    persist_credentials: true,
    auth: {
      authToken: 'token',
      deviceUid: 'device',
      collectorChannelId: 10,
      collectorStationId: 123,
    },
    body,
  };
}

test('production collector durably hands off raw text without parsing or hashing it', async () => {
  const sent = [];
  await collectRawChannel({
    DB: { name: 'production-binding' },
    CHANNEL_ALIAS: 'buddies',
    REQUEST_TIMEOUT_MS: 8_000,
    RAW_COLLECTION_QUEUE: {
      async send(message) { sent.push(message); },
    },
  }, {
    ensureSession: async () => ({
      authToken: 'token',
      deviceUid: 'device',
      tokenExpiresAt: 9_999_999_999_999,
    }),
    fetch: async () => new Response(channelBody(), { status: 200 }),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_version, 1);
  assert.equal(typeof sent[0].body, 'string');
  assert.equal(Object.hasOwn(sent[0], 'snapshot'), false);
  assert.equal(Object.hasOwn(sent[0], 'queue'), false);
});

test('normalize stage converts raw JSON to a compact snapshot and full queue', async () => {
  const sent = [];
  const result = await processRawNormalizeStage({
    CHANNEL_ALIAS: 'buddies',
    COLLECTOR_ID: 'cloudflare-worker',
  }, rawTask(), {
    send: async (message) => sent.push(message),
  });

  assert.equal(result.event, 'raw_collection_normalized');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_type, RAW_ANALYSIS_MESSAGE);
  assert.equal(sent[0].snapshot.channel_id, 10);
  assert.equal(sent[0].snapshot.station_id, 123);
  assert.equal(sent[0].queue.queue_id, 456);
  assert.equal(sent[0].queue.tracks[0].spotify_id, 'track');
  assert.equal(Object.hasOwn(sent[0], 'body'), false);
});

test('analysis stage computes hashes in a separate Queue invocation', async () => {
  const normalized = [];
  await processRawNormalizeStage({ CHANNEL_ALIAS: 'buddies' }, rawTask(), {
    send: async (message) => normalized.push(message),
  });
  const sent = [];
  const result = await processRawAnalysisStage({}, normalized[0], {
    prepareSnapshot: async () => ({ frame: { channelId: 10 }, hash: 'snapshot-hash' }),
    prepareQueue: async () => ({
      structural: { tracks: [{ position: 0 }] },
      likes: { complete: true, payload: [] },
      structural_hash: 'queue-hash',
      likes_hash: 'likes-hash',
    }),
    send: async (message) => sent.push(message),
  });

  assert.equal(result.event, 'raw_collection_analyzed');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_type, RAW_MATERIALIZE_MESSAGE);
  assert.equal(sent[0].snapshot_analysis.hash, 'snapshot-hash');
  assert.equal(sent[0].queue_analysis.structural_hash, 'queue-hash');
});

test('materialization stage emits the existing prepared v3 contract', async () => {
  const normalized = [];
  await processRawNormalizeStage({ CHANNEL_ALIAS: 'buddies' }, rawTask(), {
    send: async (message) => normalized.push(message),
  });
  const analyzed = {
    ...normalized[0],
    message_type: RAW_MATERIALIZE_MESSAGE,
    snapshot_analysis: { frame: { channelId: 10 }, hash: 'snapshot-hash' },
    queue_analysis: { structural_hash: 'queue-hash' },
  };
  const sent = [];
  const result = await processRawMaterializeStage({ DB: {} }, analyzed, {
    materialize: async (_db, queue) => ({
      queue: {
        ...queue,
        total_track_count: 80,
        materialized_track_count: 1,
        source_structural_hash: 'queue-hash',
      },
      analysis: {
        source_structural_hash: 'queue-hash',
        total_track_count: 80,
        materialized_track_count: 1,
      },
    }),
    send: async (message) => sent.push(message),
  });

  assert.equal(result.event, 'raw_collection_materialized');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_type, 'stationhead-raw-channel');
  assert.equal(sent[0].message_version, 3);
  assert.equal(sent[0].queue.total_track_count, 80);
  assert.equal(sent[0].queue.materialized_track_count, 1);
  assert.equal(Object.hasOwn(sent[0], 'body'), false);
});

test('optimized ingest routes legacy raw messages to durable normalization when the self Queue exists', async () => {
  const sent = [];
  const result = await ingestRawCollection({
    CHANNEL_ALIAS: 'buddies',
    INGEST_FINALIZE_QUEUE: {
      async send(message) { sent.push(message); },
    },
  }, rawTask());

  assert.equal(result.event, 'raw_collection_normalized');
  assert.equal(sent[0].message_type, RAW_ANALYSIS_MESSAGE);
});

test('malformed raw JSON remains on the retry and DLQ path', async () => {
  await assert.rejects(
    processRawNormalizeStage({}, rawTask('{"id":10'), { send: async () => {} }),
    /invalid raw channel JSON/,
  );
});
