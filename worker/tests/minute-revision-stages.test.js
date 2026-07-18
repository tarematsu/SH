import assert from 'node:assert/strict';
import test from 'node:test';

import {
  processMinuteDeriveRevisionChunkStage,
  processMinuteDeriveRevisionCompleteStage,
} from '../src/minute-derive-queue.js';
import { shouldStageLiveRevision } from '../src/minute-revision-stages.js';

const job = {
  id: 7,
  channel_id: 10,
  minute_at: 120_000,
  payload_version: 1,
  job_kind: 'live',
  attempts: 1,
};
const payload = {
  payload_version: 1,
  observedAt: 123_456,
  snapshot: { channel_id: 10, station_id: 20, is_broadcasting: 1 },
  queue: {
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    tracks: Array.from({ length: 15 }, (_value, position) => ({
      position,
      isrc: `JPTEST${String(position).padStart(3, '0')}`,
      duration_ms: 180_000,
    })),
  },
  comments: {},
  rebuild: null,
};

function stageBody(stage, revision) {
  return {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage,
    job,
    payload,
    revision,
    started_at: 100_000,
  };
}

test('only sufficiently large live revisions use chunked derive stages', () => {
  assert.equal(shouldStageLiveRevision({}, payload), true);
  assert.equal(shouldStageLiveRevision({}, {
    ...payload,
    queue: { ...payload.queue, tracks: payload.queue.tracks.slice(0, 5) },
  }), false);
  assert.equal(shouldStageLiveRevision({}, { ...payload, rebuild: { mode: 'exact' } }), false);
  assert.equal(shouldStageLiveRevision({}, {
    ...payload,
    snapshot: { ...payload.snapshot, is_broadcasting: 0 },
  }), false);
});

test('revision chunks requeue the next bounded chunk and renew the job lease', async () => {
  const sent = [];
  const leases = [];
  const result = await processMinuteDeriveRevisionChunkStage({ MINUTE_DB: {} }, stageBody(
    'revision-chunk',
    {
      revision_id: 50,
      cursor: 0,
      item_count: 15,
      playback_offset_ms: 0,
      schedule_valid: true,
    },
  ), {
    writeRevisionChunk: async () => ({
      revision_id: 50,
      cursor: 5,
      item_count: 15,
      playback_offset_ms: 900_000,
      schedule_valid: true,
      complete: false,
      chunk_tracks: 5,
    }),
    renewLease: async (_env, value) => leases.push(value.id),
    sendStage: async (body) => sent.push(body),
  });

  assert.deepEqual(leases, [7]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, 'revision-chunk');
  assert.equal(sent[0].revision.cursor, 5);
  assert.equal(result.event, 'minute_fact_derive_revision_chunk');
  assert.equal(result.chunk_tracks, 5);
});

test('last revision chunk hands off completion as another invocation', async () => {
  const sent = [];
  await processMinuteDeriveRevisionChunkStage({ MINUTE_DB: {} }, stageBody(
    'revision-chunk',
    {
      revision_id: 50,
      cursor: 10,
      item_count: 15,
      playback_offset_ms: 1_800_000,
      schedule_valid: true,
    },
  ), {
    writeRevisionChunk: async () => ({
      revision_id: 50,
      cursor: 15,
      item_count: 15,
      playback_offset_ms: 2_700_000,
      schedule_valid: true,
      complete: true,
      chunk_tracks: 5,
    }),
    renewLease: async () => {},
    sendStage: async (body) => sent.push(body),
  });

  assert.equal(sent[0].stage, 'revision-complete');
});

test('revision completion returns to the ordinary fact write path', async () => {
  const sent = [];
  const result = await processMinuteDeriveRevisionCompleteStage({ MINUTE_DB: {} }, stageBody(
    'revision-complete',
    {
      revision_id: 50,
      cursor: 15,
      item_count: 15,
      playback_offset_ms: 2_700_000,
      schedule_valid: true,
    },
  ), {
    completeRevision: async () => ({ revision_id: 50, item_count: 15, complete: true }),
    renewLease: async () => {},
    sendStage: async (body) => sent.push(body),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, 'write');
  assert.equal(sent[0].revision, undefined);
  assert.equal(result.event, 'minute_fact_derive_revision_completed');
});
