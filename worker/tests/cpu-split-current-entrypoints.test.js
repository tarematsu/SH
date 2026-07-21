import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { processOptimizedMinuteEnrichment } from '../src/minute-enrichment-optimized-entry.js';
import { processMinuteRebuildStage } from '../src/minute-rebuild-entry.js';
import { readModelNeedsHydration } from '../src/read-model-entry.js';
import { processTrackMetadataTask } from '../src/track-metadata-entry.js';

test('read-model hydration is deferred only for incomplete track presentation', () => {
  assert.equal(readModelNeedsHydration({ queue: { value: { tracks: [] } } }), false);
  assert.equal(readModelNeedsHydration({
    queue: {
      value: {
        tracks: [{
          spotify_id: 'spotify-complete',
          title: 'Song',
          artist: 'Artist',
          album_name: 'Album',
          thumbnail_url: 'image',
        }],
      },
    },
  }), false);
  assert.equal(readModelNeedsHydration({
    queue: {
      value: {
        tracks: [{
          spotify_id: 'spotify-incomplete',
          title: 'Song',
          artist: null,
          album_name: 'Album',
          thumbnail_url: 'image',
        }],
      },
    },
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

test('minute rebuild keeps gap scan and self-draining backfill in separate invocations', async () => {
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

test('optimized enrichment routes current stages and rejects retired fallbacks', async () => {
  let routed = 0;
  const result = await processOptimizedMinuteEnrichment({}, { stage: 'playback' }, {
    processMinutePlaybackResolve: async () => {
      routed += 1;
      return { stage: 'playback', pending: true };
    },
  });
  assert.equal(routed, 1);
  assert.equal(result.pending, true);
  await assert.rejects(
    () => processOptimizedMinuteEnrichment({}, { stage: 'buddy-playback' }),
    /unsupported minute enrichment stage/,
  );
});

test('retired split entrypoints are physically absent', () => {
  for (const path of [
    '../src/buddy-playback-entry.js',
    '../src/host-monitor-entry.js',
    '../src/minute-enrichment-entry.js',
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
  }
});
