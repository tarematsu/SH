import assert from 'node:assert/strict';
import test from 'node:test';

import { processBuddyPlaybackStage } from '../src/buddy-playback-entry.js';
import { processMinuteRebuildStage } from '../src/minute-rebuild-entry.js';
import { readModelNeedsHydration } from '../src/read-model-entry.js';
import { processTrackMetadataTask } from '../src/track-metadata-entry.js';

test('read-model hydration is deferred only for incomplete track presentation', () => {
  assert.equal(readModelNeedsHydration({ queue: { value: { tracks: [] } } }), false);
  assert.equal(readModelNeedsHydration({
    queue: {
      value: {
        tracks: [{ title: 'Song', artist: 'Artist', album_name: 'Album', thumbnail_url: 'image' }],
      },
    },
  }), false);
  assert.equal(readModelNeedsHydration({
    queue: { value: { tracks: [{ title: 'Song', artist: null, album_name: 'Album', thumbnail_url: 'image' }] } },
  }), true);
});

test('track metadata Worker routes committed and read-model tasks without widening payloads', async () => {
  const calls = [];
  const job = { jobId: 'minute-fact:1:2', payload: { queue: { tracks: [] } } };
  const committed = await processTrackMetadataTask({}, {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'committed-enrichment',
    job,
  }, {
    async runCommittedMetadataEnrichment(_env, jobs) {
      calls.push({ kind: 'committed', jobs });
    },
  });
  const hydrated = await processTrackMetadataTask({}, {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'read-model-hydration',
    job_id: 'read-model:1:2',
    read_model: { queue: { value: null } },
  }, {
    async saveMinuteFactReadModels(_env, readModel, jobId) {
      calls.push({ kind: 'read-model', readModel, jobId });
    },
  });

  assert.deepEqual(committed, { task: 'committed-enrichment', job_id: job.jobId });
  assert.deepEqual(hydrated, { task: 'read-model-hydration', job_id: 'read-model:1:2' });
  assert.equal(calls[0].jobs[0], job);
  assert.equal(calls[1].jobId, 'read-model:1:2');
});

test('pending buddy playback stages are requeued as separate invocations', async () => {
  const sent = [];
  const env = {
    BUDDY_PLAYBACK_ENABLED: true,
    BUDDY_PLAYBACK_QUEUE: {
      async send(body, options) {
        sent.push({ body, options });
      },
    },
  };
  const result = await processBuddyPlaybackStage(env, {
    message_type: 'buddy-playback-stage',
    message_version: 1,
    scheduled_at: 1_800_000,
    observed_at: 1_800_123,
  }, {
    advance: async () => ({ pending: true, stage: 'parse', cycle_at: 1_800_000 }),
  });

  assert.equal(result.requeued, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.message_type, 'buddy-playback-stage');
  assert.equal(sent[0].body.scheduled_at, 1_800_000);
  assert.equal(sent[0].options.delaySeconds, 1);
});

test('minute rebuild splits gap scan and self-draining backfill into separate invocations', async () => {
  const enqueued = [];
  const recorded = [];
  const env = { BUDDIES_DB: {}, MINUTE_DB: {} };
  const body = {
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    run_id: 'minute-rebuild:123',
    scheduled_at: 123,
  };
  const common = {
    async recordStage(_env, task, result, _startedAt, success = true) {
      recorded.push({ stage: task.stage, result, success });
    },
    async enqueueStage(_env, task, stage, delaySeconds = 0) {
      enqueued.push({ runId: task.runId, stage, delaySeconds });
    },
  };

  const gap = await processMinuteRebuildStage(env, { ...body, stage: 'gap-scan' }, {
    ...common,
    runGapScan: async (active) => {
      assert.equal(active.DB, env.BUDDIES_DB);
      return { enqueued: 1 };
    },
  });
  const backfill = await processMinuteRebuildStage(env, { ...body, stage: 'backfill' }, {
    ...common,
    runBackfill: async () => ({ enqueued: 1, scanned_snapshots: 10, pending_candidates: 4 }),
  });

  assert.equal(gap.pending, true);
  assert.equal(backfill.pending, true);
  assert.deepEqual(enqueued, [
    { runId: body.run_id, stage: 'backfill', delaySeconds: 0 },
    { runId: body.run_id, stage: 'backfill', delaySeconds: 1 },
  ]);
  assert.deepEqual(recorded.map((item) => item.stage), ['gap-scan', 'backfill']);
});
