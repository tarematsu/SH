import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('optimized and legacy ingest paths share the parsed body without an Apple compatibility adapter', () => {
  const source = readFileSync(new URL('../functions/api/ingest.js', import.meta.url), 'utf8');
  const internal = source.slice(source.indexOf('export async function ingestInternal'));
  assert.match(internal, /const body = parsed\.body/);
  assert.match(internal, /requestWithParsedJson\(request, body\)/);
  assert.match(internal, /ingestOptimizedBody\(env, body\)/);
  assert.match(internal, /corePost\(fallbackContext\)/);
  assert.doesNotMatch(source, /stripAppleMusicFields|appleMusicFree/i);
  assert.doesNotMatch(internal, /ingestOptimizedBody\(env, parsed\.body\)/);
});
