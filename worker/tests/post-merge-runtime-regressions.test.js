import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { snapshotPersistenceDue } from '../src/collector-ingest.js';
import { compactMaterializeMessage } from '../src/ingest-channel-optimized-entry.js';
import {
  activeDeriveEnv,
  LIVE_DERIVE_QUEUE_NAME,
  REBUILD_DERIVE_QUEUE_NAME,
  shouldLogMinuteDeriveResult,
} from '../src/minute-derive-entry.js';
import { runPagesReadModelQueue } from '../src/pages-read-model-entry.js';

const MINUTE = 60_000;

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('consolidated Pages Worker routes minute read-model messages even when batch.queue is absent', async () => {
  const events = [];
  const message = {
    body: {
      message_type: 'stationhead-read-model',
      message_version: 1,
      job_id: 'read-model:1:2',
      read_model: {
        queue: {
          value: {
            tracks: [{ title: null, artist: null, album_name: null, thumbnail_url: null }],
          },
        },
      },
    },
    ack() { events.push('ack'); },
    retry() { events.push('retry'); },
  };

  await runPagesReadModelQueue({ messages: [message] }, {
    TRACK_METADATA_QUEUE: {
      async send() { events.push('metadata'); },
    },
  });

  assert.deepEqual(events, ['metadata', 'ack']);
});

test('optional comments degrade after one failed collection attempt', () => {
  const comments = config('wrangler.comments.jsonc');
  assert.equal(comments.vars.COMMENT_CHAIN_MAX_ATTEMPTS, 1);
  assert.equal(comments.vars.CHAT_LIMIT > 0, true);
});

test('ingest persists operational snapshots once per five-minute slot', () => {
  const env = { SNAPSHOT_PERSIST_INTERVAL_MS: 5 * MINUTE };
  const boundary = Date.UTC(2026, 0, 1, 0, 5, 0);
  assert.equal(snapshotPersistenceDue(env, boundary), true);
  assert.equal(snapshotPersistenceDue(env, boundary + MINUTE), false);
  assert.equal(snapshotPersistenceDue({}, boundary + MINUTE), true);

  const ingest = config('wrangler.ingest.jsonc');
  assert.equal(ingest.vars.SNAPSHOT_PERSIST_INTERVAL_MS, 5 * MINUTE);
});

test('ingest drops duplicate collected metadata when the dedicated pipeline owns hydration', () => {
  const body = {
    message_type: 'stationhead-raw-materialize',
    track_metadata: [{ spotify_id: 'track-1', title: 'title' }],
    queue: { tracks: [{ spotify_id: 'track-1' }] },
  };
  const compact = compactMaterializeMessage({ COLLECTED_METADATA_PERSIST_ENABLED: false }, body);
  assert.notEqual(compact, body);
  assert.deepEqual(compact.track_metadata, []);
  assert.equal(compact.queue, body.queue);
  assert.equal(compactMaterializeMessage({ COLLECTED_METADATA_PERSIST_ENABLED: true }, body), body);
});

test('live derive uses one-track chunks while rebuild keeps the configured batch', () => {
  const liveQueue = { send() {} };
  const rebuildQueue = { send() {} };
  const env = {
    DERIVE_REVISION_CHUNK_TRACKS: 2,
    MINUTE_LIVE_DERIVE_QUEUE: liveQueue,
    MINUTE_DERIVE_QUEUE: rebuildQueue,
  };
  const live = activeDeriveEnv({ queue: LIVE_DERIVE_QUEUE_NAME }, env);
  const rebuild = activeDeriveEnv({ queue: REBUILD_DERIVE_QUEUE_NAME }, env);
  assert.equal(live.DERIVE_REVISION_CHUNK_TRACKS, 1);
  assert.equal(live.MINUTE_DERIVE_QUEUE, liveQueue);
  assert.equal(rebuild.DERIVE_REVISION_CHUNK_TRACKS, 2);
  assert.equal(rebuild.MINUTE_DERIVE_QUEUE, rebuildQueue);
});

test('minute derive success logs are sampled but failures are always retained', () => {
  assert.equal(shouldLogMinuteDeriveResult({ job_id: 16, failed: 0 }), true);
  assert.equal(shouldLogMinuteDeriveResult({ job_id: 17, failed: 0 }), false);
  assert.equal(shouldLogMinuteDeriveResult({ job_id: 17, failed: 1 }), true);
});
