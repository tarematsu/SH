import assert from 'node:assert/strict';
import test from 'node:test';

import { ingest } from '../src/collector-ingest.js';
import { collectRawChannel } from '../src/raw-collector-entry.js';

const MINUTE = 60_000;

test('scheduled inline collection bypasses RAW_COLLECTION_QUEUE', async () => {
  const ingested = [];
  const body = JSON.stringify({
    id: 10,
    alias: 'buddies',
    current_station_id: 123,
    current_station: {
      id: 123,
      queue: {
        id: 456,
        start_time: 1_784_000_000_000,
        is_paused: false,
        queue_tracks: [],
      },
    },
  });
  const result = await collectRawChannel({
    CHANNEL_ALIAS: 'buddies',
    REQUEST_TIMEOUT_MS: 8_000,
    COLLECTOR_INLINE_PIPELINE_ENABLED: true,
  }, {
    ensureSession: async () => ({
      authToken: 'token',
      deviceUid: 'device',
      tokenExpiresAt: 9_999_999_999_999,
    }),
    fetch: async () => new Response(body, { status: 200 }),
    ingestRawCollection: async (_env, message, options) => ingested.push({ message, options }),
  });

  assert.equal(result.inline, true);
  assert.equal(result.message_version, 3);
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].message.snapshot.channel_id, 10);
  assert.equal(ingested[0].message.queue.queue_id, 456);
  assert.deepEqual(ingested[0].options, { inline: true });
});

test('inline snapshot ingest preserves the configured checkpoint interval', async () => {
  const boundary = Date.UTC(2026, 0, 1, 0, 20, 0);
  let dbCalls = 0;
  const result = await ingest({
    SNAPSHOT_PERSIST_INTERVAL_MS: 20 * MINUTE,
    DB: {
      prepare() {
        dbCalls += 1;
        throw new Error('snapshot DB must not be touched outside the checkpoint slot');
      },
    },
  }, 'snapshot', { channel_id: 10 }, boundary + MINUTE, { returnDetails: true });

  assert.deepEqual(result, {
    ok: true,
    type: 'snapshot',
    accepted: true,
    deferred: false,
    inserted: false,
    skipped: true,
    reason: 'snapshot-persistence-not-due',
  });
  assert.equal(dbCalls, 0);
});
