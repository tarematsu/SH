import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { processTrackMetadataTask } from '../src/track-metadata-entry.js';

function committedBody(task = 'committed-enrichment') {
  return {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task,
    job: {
      jobId: 'queue-metadata:1:2',
      payload: {
        observedAt: 2,
        queue: { tracks: [{ position: 0, isrc: 'JPTEST000001' }] },
      },
    },
  };
}

test('committed metadata separates Spotify and ISRC work into Queue Invocations', async () => {
  const calls = [];
  const sent = [];
  const body = committedBody();
  const first = await processTrackMetadataTask({
    TRACK_METADATA_QUEUE: {
      async send(message, options) { sent.push({ message, options }); },
    },
  }, body, {
    async runCommittedSpotifyMetadataEnrichment(_env, jobs) {
      calls.push(['spotify', jobs[0].jobId]);
    },
  });

  assert.deepEqual(calls, [['spotify', body.job.jobId]]);
  assert.equal(first.pending, true);
  assert.equal(first.next_task, 'committed-enrichment-isrc');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.task, 'committed-enrichment-isrc');
  assert.equal(sent[0].message.job, body.job);
  assert.deepEqual(sent[0].options, { contentType: 'json' });

  const second = await processTrackMetadataTask({}, sent[0].message, {
    async runCommittedIsrcMetadataEnrichment(_env, jobs) {
      calls.push(['isrc', jobs[0].jobId]);
    },
  });
  assert.deepEqual(calls, [
    ['spotify', body.job.jobId],
    ['isrc', body.job.jobId],
  ]);
  assert.equal(second.pending, false);
});

test('legacy injected combined enrichment remains a direct-call compatibility path', async () => {
  const calls = [];
  const body = committedBody();
  const result = await processTrackMetadataTask({}, body, {
    async runCommittedMetadataEnrichment(_env, jobs) {
      calls.push(jobs[0].jobId);
    },
  });
  assert.deepEqual(calls, [body.job.jobId]);
  assert.deepEqual(result, {
    task: 'committed-enrichment',
    job_id: body.job.jobId,
    pending: false,
  });
});

test('staged revision reuse has a matching partial composite index', () => {
  const migration = readFileSync(
    new URL('../../database/facts-migrations/019_d1_budget_indexes.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /idx_sh_queue_revisions_reuse/);
  assert.match(migration, /channel_id,\s*structural_hash,\s*session_id,\s*queue_start_time/);
  assert.match(migration, /WHERE status IN \('complete','pending'\)/);
});

test('committed metadata caches stage modules instead of allocating import groups per job', () => {
  const source = readFileSync(
    new URL('../src/committed-metadata-enrichment.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /configModulePromise \|\|=/);
  assert.match(source, /spotifyModulePromise \|\|=/);
  assert.match(source, /isrcModulePromise \|\|=/);
  assert.match(source, /runCommittedSpotifyMetadataEnrichment/);
  assert.match(source, /runCommittedIsrcMetadataEnrichment/);
  assert.doesNotMatch(source, /Promise\.all\(\[/);
});
