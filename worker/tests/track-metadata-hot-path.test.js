import assert from 'node:assert/strict';
import test from 'node:test';

import { processTrackMetadataTask } from '../src/track-metadata-entry.js';

test('committed metadata Queue tasks delegate the validated single job unchanged', async () => {
  const job = {
    jobId: 'metadata:10:20',
    payload: {
      observedAt: 20,
      queue: { tracks: [{ spotify_id: 'track-1', isrc: 'JPAAA0000001' }] },
    },
  };
  const calls = [];

  const result = await processTrackMetadataTask({}, {
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'committed-enrichment',
    job,
  }, {
    runCommittedMetadataEnrichment: async (env, jobs, options) => {
      calls.push({ env, jobs, options });
    },
    enrichment: { marker: true },
  });

  assert.deepEqual(result, { task: 'committed-enrichment', job_id: job.jobId });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].jobs, [job]);
  assert.deepEqual(calls[0].options, { marker: true });
});
