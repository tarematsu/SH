import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MINUTE_FACT_INBOX_INDEX_SQL,
  MINUTE_FACT_INBOX_SCHEMA_SQL,
  minuteFactJobPayload,
} from '../src/minute-facts-inbox.js';

test('minute fact inbox payload preserves raw capture input', () => {
  const input = {
    observedAt: 123_456,
    snapshot: { channel_id: 10, listener_count: 42 },
    queue: { queue_id: 20, tracks: [{ position: 0 }] },
    comments: { commentCount: 3, degraded: false },
  };
  const payload = minuteFactJobPayload(input);

  assert.deepEqual(payload, {
    payload_version: 1,
    observedAt: 123_456,
    snapshot: input.snapshot,
    queue: input.queue,
    comments: input.comments,
    rebuild: null,
  });
});

test('minute fact inbox schema is unique per channel minute and indexed for pending work', () => {
  assert.match(MINUTE_FACT_INBOX_SCHEMA_SQL, /UNIQUE\(channel_id, minute_at\)/);
  assert.match(MINUTE_FACT_INBOX_SCHEMA_SQL, /payload_json TEXT NOT NULL/);
  assert.match(MINUTE_FACT_INBOX_INDEX_SQL, /status, job_priority DESC, next_attempt_at, minute_at/);
});
