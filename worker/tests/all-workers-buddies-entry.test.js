import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('the default production entry is the consolidated monitor with raw collection', () => {
  const config = source('../wrangler.jsonc');
  const consolidated = source('../src/consolidated-monitor-entry.js');
  const collector = source('../src/raw-collector-entry.js');
  assert.match(config, /"name"\s*:\s*"sh-monitor-other"/);
  assert.match(config, /"main"\s*:\s*"src\/other-entry\.js"/);
  assert.match(config, /"binding"\s*:\s*"RAW_COLLECTION_QUEUE"/);
  assert.match(consolidated, /collectRawChannel/);
  assert.match(consolidated, /rawCollectorEnv/);
  assert.match(collector, /const RAW_COLLECTION_QUEUE_OPTIONS = Object\.freeze/);
  assert.doesNotMatch(collector, /export default \{[^}]*\bfetch\s*:/s);
});

test('buddies ingest uses one-message switch dispatch and no HTTP handler', () => {
  const config = source('../wrangler.ingest.jsonc');
  const entry = source('../src/ingest-channel-optimized-entry.js');
  assert.match(config, /"max_batch_size"\s*:\s*1\b/g);
  assert.match(entry, /const message = messages\[0\]/);
  assert.match(entry, /switch \(type\)/);
  assert.match(entry, /const EMPTY_DEPENDENCIES = Object\.freeze/);
  assert.doesNotMatch(entry, /for\s*\(const message of|fetch\s*\(/);
});

test('buddies persist deploys a queue-only one-message wrapper', () => {
  const config = source('../wrangler.persist.jsonc');
  const entry = source('../src/persist-channel-optimized-entry.js');
  assert.match(config, /"main"\s*:\s*"src\/persist-channel-optimized-entry\.js"/);
  assert.match(config, /"max_batch_size"\s*:\s*1\b/);
  assert.match(entry, /const message = messages\[0\]/);
  assert.doesNotMatch(entry, /for\s*\(|fetch\s*\(/);
});

test('buddies comments keeps the cached wrapper and fetch contract', () => {
  const config = source('../wrangler.comments.jsonc');
  const entry = source('../src/comments-cpu-entry.js');
  assert.match(config, /"max_batch_size"\s*:\s*1\b/);
  assert.match(entry, /const trackCount = tracks\.length/);
  assert.match(entry, /const activeCommentsEnvs = new WeakMap/);
  assert.match(entry, /fetch: commentsWorker\.fetch/);
});
