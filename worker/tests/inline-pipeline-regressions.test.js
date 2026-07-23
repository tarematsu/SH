import assert from 'node:assert/strict';
import test from 'node:test';

import { ingest } from '../src/collector-ingest.js';

const MINUTE = 60_000;

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
