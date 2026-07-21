import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL,
  COMPLETE_MINUTE_FACT_JOB_SQL,
  MINUTE_FACT_INBOX_INDEX_SQL,
  MINUTE_FACT_INBOX_SCHEMA_SQL,
  minuteFactJobPayload,
  REQUEUE_DEAD_MINUTE_FACT_JOBS_SQL,
} from '../src/minute-facts-inbox.js';

test('minute fact inbox payload preserves raw capture input until generation completes', () => {
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

test('job completion clears its payload only after dependent revisions are complete', () => {
  assert.match(COMPLETE_MINUTE_FACT_JOB_SQL, /status='done'/);
  assert.match(COMPLETE_MINUTE_FACT_JOB_SQL, /source_job_id=sh_minute_fact_jobs\.id/);
  assert.match(COMPLETE_MINUTE_FACT_JOB_SQL, /revisions\.status<>'complete'/);
  assert.match(COMPLETE_MINUTE_FACT_JOB_SQL, /materialized_item_count/);
  assert.match(COMPLETE_MINUTE_FACT_JOB_SQL, /THEN payload_json ELSE '' END/);
});

test('bounded backlog cleanup preserves payloads that an incomplete revision still needs', () => {
  assert.match(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL, /jobs\.status='done'/);
  assert.match(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL, /LENGTH\(jobs\.payload_json\)>0/);
  assert.match(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL, /NOT EXISTS/);
  assert.match(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL, /LIMIT \?/);
  assert.match(CLEAR_COMPLETED_MINUTE_FACT_PAYLOADS_SQL, /RETURNING id/);
});

test('dead-job recovery only retries missing facts and leaves poison payloads for rebuild', () => {
  assert.match(REQUEUE_DEAD_MINUTE_FACT_JOBS_SQL, /NOT EXISTS[\s\S]*FROM sh_minute_facts/);
  assert.match(REQUEUE_DEAD_MINUTE_FACT_JOBS_SQL, /facts\.channel_id=jobs\.channel_id/);
  assert.match(REQUEUE_DEAD_MINUTE_FACT_JOBS_SQL, /facts\.minute_at=jobs\.minute_at/);
  assert.match(REQUEUE_DEAD_MINUTE_FACT_JOBS_SQL, /invalid minute fact job payload/);
  assert.match(REQUEUE_DEAD_MINUTE_FACT_JOBS_SQL, /unsupported minute fact payload version/);
  assert.match(REQUEUE_DEAD_MINUTE_FACT_JOBS_SQL, /RETURNING id/);
});
