import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  processMinuteEnrichmentBatch,
  processOptimizedMinuteEnrichment,
} from '../src/minute-enrichment-optimized-entry.js';

const optimizedSource = readFileSync(
  new URL('../src/minute-enrichment-optimized-entry.js', import.meta.url),
  'utf8',
);
const playbackSource = readFileSync(
  new URL('../src/minute-enrichment-playback-stages.js', import.meta.url),
  'utf8',
);

test('optimized enrichment has no legacy entrypoint or Apple handoff field', () => {
  assert.doesNotMatch(optimizedSource, /minute-enrichment-entry\.js/);
  assert.doesNotMatch(playbackSource, /apple_music_id/);
  assert.equal(existsSync(new URL('../src/minute-enrichment-entry.js', import.meta.url)), false);
});

test('unsupported enrichment stages fail instead of using a fallback entrypoint', async () => {
  await assert.rejects(
    () => processOptimizedMinuteEnrichment({}, { stage: 'retired-stage' }),
    /unsupported minute enrichment stage/,
  );
});

test('configured one-message batches retain ack semantics through the optimized dispatcher', async () => {
  let acknowledged = 0;
  let retried = 0;
  const body = { stage: 'playback', minute_at: 120_000 };
  await processMinuteEnrichmentBatch({
    messages: [{
      body,
      ack() { acknowledged += 1; },
      retry() { retried += 1; },
    }],
  }, {}, {
    processMinutePlaybackResolve: async (_env, value) => ({
      skipped: false,
      stage: value.stage,
      minuteAt: value.minute_at,
    }),
  });

  assert.equal(acknowledged, 1);
  assert.equal(retried, 0);
});
