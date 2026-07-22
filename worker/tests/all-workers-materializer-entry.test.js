import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('minute enrichment owns four isolated one-message Queue boundaries', () => {
  const config = source('../wrangler.minute-enrichment.jsonc');
  const enrichment = source('../src/minute-enrichment-optimized-entry.js');
  const metadata = source('../src/track-metadata-entry.js');
  assert.equal((config.match(/"max_batch_size"\s*:\s*1\b/g) || []).length, 4);
  assert.match(config, /stationhead-track-metadata/);
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
  const config = source('../wrangler.minute-enrichment.jsonc');
  const entry = source('../src/pages-read-model-entry.js');
  assert.match(config, /"max_batch_size"\s*:\s*1\b/);
  assert.match(entry, /if \(declaredFailed === 0\) return result/);
  assert.match(entry, /const message = messages\[0\]/);
  assert.doesNotMatch(entry, /EMPTY_MESSAGES|for \(let index = 0; index < messages\.length/);
});
