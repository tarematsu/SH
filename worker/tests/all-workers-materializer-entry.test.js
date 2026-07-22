import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function runtimeConfig() {
  return JSON.parse(source('../wrangler.runtime.jsonc'));
}

test('core Worker preserves four isolated enrichment and Pages Queue boundaries', () => {
  const config = runtimeConfig();
  const enrichment = source('../src/minute-enrichment-optimized-entry.js');
  const metadata = source('../src/track-metadata-entry.js');
  const queues = [
    'stationhead-minute-enrichment',
    'stationhead-track-metadata',
    'stationhead-pages-read-model-publication',
    'stationhead-read-model',
  ];
  for (const queue of queues) {
    const consumer = config.queues.consumers.find((item) => item.queue === queue);
    assert.equal(consumer.max_batch_size, 1, queue);
    assert.equal(consumer.max_concurrency, 1, queue);
  }
  assert.match(enrichment, /TRACK_METADATA_MESSAGE_TYPE/);
  assert.match(enrichment, /processTrackMetadataTask/);
  assert.match(enrichment, /const message = messages\[0\]/);
  assert.match(metadata, /from '\.\/committed-metadata-enrichment\.js'/);
  assert.match(metadata, /from '\.\/read-model-stages\.js'/);
  assert.doesNotMatch(metadata, /committedEnrichmentModulePromise|readModelStagesModulePromise/);
  assert.match(metadata, /const JSON_QUEUE_SEND_OPTIONS = Object\.freeze/);
  assert.doesNotMatch(enrichment, /for\s*\(const message of/);
});

test('Pages read model fast-paths successful Cron and one-message Queue invocations', () => {
  const config = runtimeConfig();
  const entry = source('../src/pages-read-model-entry.js');
  const publication = config.queues.consumers.find(
    ({ queue }) => queue === 'stationhead-pages-read-model-publication',
  );
  assert.equal(publication.max_batch_size, 1);
  assert.match(entry, /if \(declaredFailed === 0\) return result/);
  assert.match(entry, /const message = messages\[0\]/);
  assert.doesNotMatch(entry, /EMPTY_MESSAGES|for \(let index = 0; index < messages\.length/);
});
