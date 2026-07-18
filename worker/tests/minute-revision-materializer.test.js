import assert from 'node:assert/strict';
import test from 'node:test';

import { processMinuteDeriveMessage } from '../src/minute-derive-router.js';
import {
  preferredQueuePosition,
  prepareSparseLiveRevision,
  writeSparseLiveRevisionChunk,
} from '../src/minute-revision-materializer.js';

const payload = {
  payload_version: 1,
  observedAt: 370_000,
  snapshot: {
    channel_id: 10,
    station_id: 20,
    is_broadcasting: 1,
    host_account_id: 30,
    host_handle: 'host',
  },
  queue: {
    station_id: 20,
    queue_id: 40,
    start_time: 10_000,
    current_position: 3,
    total_track_count: 6,
    tracks: Array.from({ length: 6 }, (_value, position) => ({
      position,
      queue_track_id: 100 + position,
      stationhead_track_id: 200 + position,
      isrc: `JPTEST${position}`,
      duration_ms: 120_000,
      bite_count: position,
    })),
  },
  comments: {},
  rebuild: null,
};

const job = {
  id: 7,
  channel_id: 10,
  minute_at: 360_000,
  payload_version: 1,
  job_kind: 'live',
  attempts: 1,
};

function writeBody() {
  return {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'write',
    job,
    payload,
    started_at: 360_000,
  };
}

test('preferred queue position follows the playback clock without requiring resolved items', () => {
  assert.equal(preferredQueuePosition(payload.queue, 370_000), 3);
  assert.equal(preferredQueuePosition({
    ...payload.queue,
    current_position: null,
    is_paused: 1,
  }, 370_000), 0);
});

test('sparse revision preparation pins the durable minute job and keeps partial coverage valid', async () => {
  const updates = [];
  const result = await prepareSparseLiveRevision({
    MINUTE_DB: {},
    DERIVE_REVISION_STAGE_TRACKS: 1,
  }, payload, {
    sourceJobId: job.id,
  }, {
    resolveLiveSession: async () => 50,
    findReusableRevision: async () => ({ id: 60, status: 'complete', item_count: 4 }),
    revisionProgress: async () => 2,
    updateRevisionSource: async () => updates.push('updated'),
  });

  assert.equal(result.staged, true);
  assert.equal(result.revision_id, 60);
  assert.equal(result.source_job_id, 7);
  assert.equal(result.visible_item_count, 6);
  assert.equal(result.total_item_count, 6);
  assert.equal(result.materialized_item_count, 2);
  assert.equal(result.preferred_position, 3);
  assert.deepEqual(updates, ['updated']);
});

test('live fact write completes before compact revision materialization is queued', async () => {
  const sent = [];
  let written = null;
  const result = await processMinuteDeriveMessage({
    MINUTE_DB: {},
    DERIVE_REVISION_STAGE_TRACKS: 1,
  }, writeBody(), {
    write: async (_env, value) => { written = value; },
    sendStage: async (message, options = {}) => sent.push({ message, options }),
    materializer: {
      resolveLiveSession: async () => 50,
      findReusableRevision: async () => ({ id: 60, status: 'pending', item_count: 6 }),
      revisionProgress: async () => 0,
      updateRevisionSource: async () => {},
    },
  });

  assert.equal(written.prepared_revision.revision_id, 60);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].message.stage, 'complete');
  assert.equal(sent[1].message.stage, 'revision-materialize');
  assert.equal(sent[1].message.payload, undefined);
  assert.equal(result.revision_pending, true);
});

test('sparse chunk requeues one minute later and refreshes playback only for the preferred window', async () => {
  const sent = [];
  const enrichment = [];
  const revision = {
    sparse: true,
    revision_id: 60,
    source_job_id: 7,
    visible_item_count: 6,
    total_item_count: 6,
    preferred_position: 3,
    enrichment: {
      channel_id: 10,
      minute_at: 360_000,
      observed_at: 370_000,
      station_id: 20,
      provisional_session_id: 50,
      queue_start_time: 10_000,
      is_paused: false,
      is_broadcasting: 1,
    },
    queue_identity: {
      station_id: 20,
      queue_id: 40,
      start_time: 10_000,
      total_track_count: 6,
    },
  };
  const result = await processMinuteDeriveMessage({
    DERIVE_REVISION_INTERVAL_SECONDS: 60,
  }, {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'revision-materialize',
    job,
    revision,
    started_at: 360_000,
  }, {
    writeSparseRevisionChunk: async () => ({
      ...revision,
      complete: false,
      coverage_complete: false,
      materialized_item_count: 3,
      chunk_tracks: 3,
      preferred_resolved: true,
      source_tracks: payload.queue.tracks.slice(3, 6),
    }),
    sendStage: async (message, options = {}) => sent.push({ message, options }),
    sendEnrichment: async (message) => enrichment.push(message),
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.stage, 'revision-materialize');
  assert.equal(sent[0].message.payload, undefined);
  assert.equal(sent[0].options.delaySeconds, 60);
  assert.equal(enrichment.length, 1);
  assert.equal(enrichment[0].stage, 'playback');
  assert.deepEqual(enrichment[0].queue.tracks.map((track) => track.position), [3, 4, 5]);
  assert.equal(result.pending, true);
});

test('sparse materialization accepts non-contiguous preferred positions', async () => {
  const inserted = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return { item_count: 3 }; },
        async run() { inserted.push(this.args); return { meta: { changes: 1 } }; },
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return statements.map(() => ({ success: true }));
    },
  };
  const result = await writeSparseLiveRevisionChunk({
    MINUTE_DB: db,
    DERIVE_REVISION_CHUNK_TRACKS: 3,
  }, {
    sparse: true,
    revision_id: 60,
    source_job_id: 7,
    visible_item_count: 6,
    total_item_count: 6,
    preferred_position: 3,
    enrichment: { channel_id: 10, minute_at: 360_000, observed_at: 370_000 },
  }, {
    loadSourceTracks: async () => payload.queue.tracks.slice(3, 6).map((track) => ({
      ...track,
      playback_offset_ms: track.position * 120_000,
      schedule_valid: 1,
    })),
    resolveTracksBulk: async (_db, _oldDb, tracks) => tracks.map((track) => ({
      ...track,
      trackId: 1_000 + track.position,
    })),
    materializedCount: async () => ({ item_count: 3 }),
    updateCoverage: async () => {},
  });

  assert.equal(result.chunk_tracks, 3);
  assert.equal(result.materialized_item_count, 3);
  assert.equal(result.complete, false);
  assert.equal(result.preferred_resolved, true);
  assert.equal(inserted.length, 3);
  assert.deepEqual(inserted.map((args) => args[1]), [3, 4, 5]);
});
