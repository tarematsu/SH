import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  TRACK_METADATA_QUEUE_NAME,
  isTrackMetadataDelivery,
  processMinuteEnrichmentBatch,
  shouldLogTrackMetadataResult,
} from '../src/minute-enrichment-optimized-entry.js';

function message(body, events) {
  return {
    body,
    ack() { events.push('ack'); },
    retry() { events.push('retry'); },
  };
}

test('the consolidated enrichment route handles metadata by durable message type', async () => {
  const events = [];
  const calls = [];
  await processMinuteEnrichmentBatch({
    messages: [message({
      message_type: 'stationhead-track-metadata',
      message_version: 1,
      task: 'read-model-write',
    }, events)],
  }, {}, {
    async processTrackMetadataTask(_env, body) {
      calls.push(body.task);
      return { task: body.task, pending: false };
    },
  });
  assert.deepEqual(calls, ['read-model-write']);
  assert.deepEqual(events, ['ack']);
});

test('metadata routing also recognizes the Queue name during migration', () => {
  assert.equal(isTrackMetadataDelivery({ queue: TRACK_METADATA_QUEUE_NAME }, {}), true);
  assert.equal(isTrackMetadataDelivery({}, { message_type: 'stationhead-track-metadata' }), true);
  assert.equal(isTrackMetadataDelivery({}, { stage: 'identity' }), false);
});

test('successful metadata logs are deterministically sampled instead of emitted for every task', () => {
  const first = shouldLogTrackMetadataResult({ job_id: 'job-42', pending: false });
  assert.equal(shouldLogTrackMetadataResult({ job_id: 'job-42', pending: false }), first);
  const sampled = Array.from({ length: 256 }, (_value, index) => (
    shouldLogTrackMetadataResult({ job_id: `job-${index}`, pending: false })
  )).filter(Boolean).length;
  assert.ok(sampled > 0);
  assert.ok(sampled < 32);
  assert.equal(shouldLogTrackMetadataResult({ pending: false }), false);
  assert.equal(shouldLogTrackMetadataResult({ job_id: 'job-error', reason: 'degraded' }), true);
});

test('core config owns metadata and Pages queues while retired configs stay inactive', () => {
  const config = JSON.parse(readFileSync(
    new URL('../wrangler.runtime.jsonc', import.meta.url),
    'utf8',
  ));
  const consumers = new Set(config.queues.consumers.map(({ queue }) => queue));
  for (const queue of [
    'stationhead-minute-enrichment',
    'stationhead-track-metadata',
    'stationhead-pages-read-model-publication',
    'stationhead-read-model',
  ]) {
    assert.equal(consumers.has(queue), true, queue);
  }
  assert.equal(config.queues.producers.some(({ binding }) => binding === 'TRACK_METADATA_QUEUE'), true);
  assert.equal(existsSync(new URL('../wrangler.track-metadata.jsonc', import.meta.url)), false);
  assert.equal(existsSync(new URL('../wrangler.minute-enrichment.jsonc', import.meta.url)), false);
});
