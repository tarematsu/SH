import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('track metadata caches lazy stage modules and dispatches one message', () => {
  const config = source('../wrangler.track-metadata.jsonc');
  const entry = source('../src/track-metadata-entry.js');
  assert.match(config, /"max_batch_size"\s*:\s*1\b/);
  assert.match(entry, /committedEnrichmentModulePromise \|\|=/);
  assert.match(entry, /readModelStagesModulePromise \|\|=/);
  assert.match(entry, /const JSON_QUEUE_SEND_OPTIONS = Object\.freeze/);
  assert.match(entry, /const message = messages\[0\]/);
  assert.doesNotMatch(entry, /for\s*\(const message of|fetch\s*\(/);
});

test('Pages read model fast-paths successful Cron and one-message Queue invocations', () => {
  const config = source('../wrangler.pages-read-model.jsonc');
  const entry = source('../src/pages-read-model-entry.js');
  assert.match(config, /"max_batch_size"\s*:\s*1\b/);
  assert.match(entry, /if \(declaredFailed === 0\) return result/);
  assert.match(entry, /const message = messages\[0\]/);
  assert.doesNotMatch(entry, /EMPTY_MESSAGES|for \(let index = 0; index < messages\.length/);
});
