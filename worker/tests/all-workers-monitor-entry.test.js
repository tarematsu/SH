import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('monitor maintenance caches lazy modules and exposes scheduled work only', () => {
  const entry = source('../src/monitor-maintenance-entry.js');
  assert.match(entry, /cronStaggerModulePromise \|\|=/);
  assert.match(entry, /rollupModulePromise \|\|=/);
  assert.match(entry, /retentionModulePromise \|\|=/);
  assert.match(entry, /const EMPTY_DEPENDENCIES = Object\.freeze/);
  assert.match(entry, /export default \{\s*scheduled:/s);
  assert.doesNotMatch(entry, /fetch\s*\(/);
});

test('other monitor avoids Date allocation and caches task modules', () => {
  const config = source('../wrangler.other.jsonc');
  const entry = source('../src/other-monitor-entry.js');
  assert.match(config, /"max_batch_size"\s*:\s*1\b/g);
  assert.match(entry, /Math\.floor\(now \/ MINUTE_MS\) % 60/);
  assert.doesNotMatch(entry, /new Date\(now\)/);
  assert.match(entry, /buddyPipelineModulePromise \|\|=/);
  assert.match(entry, /hostMonitorModulePromise \|\|=/);
  assert.match(entry, /predictionModulePromise \|\|=/);
  assert.match(entry, /const JSON_QUEUE_SEND_OPTIONS = Object\.freeze/);
  assert.match(entry, /const message = messages\[0\]/);
  assert.doesNotMatch(entry, /for \(const message of batch/);
});
