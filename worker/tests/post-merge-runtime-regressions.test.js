import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { snapshotPersistenceDue } from '../src/collector-ingest.js';
import { compactMaterializeMessage } from '../src/ingest-channel-optimized-entry.js';
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
