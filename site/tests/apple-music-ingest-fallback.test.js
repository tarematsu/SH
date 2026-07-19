import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('optimized and legacy ingest paths share one Apple-free parsed body', () => {
  const source = readFileSync(new URL('../functions/api/ingest.js', import.meta.url), 'utf8');
  const internal = source.slice(source.indexOf('export async function ingestInternal'));
  assert.match(internal, /const body = stripAppleMusicFields\(parsed\.body\)/);
  assert.match(internal, /requestWithParsedJson\(request, body\)/);
  assert.match(internal, /ingestOptimizedBody\(env, body\)/);
  assert.match(internal, /corePost\(fallbackContext\)/);
  assert.doesNotMatch(internal, /ingestOptimizedBody\(env, parsed\.body\)/);
  assert.doesNotMatch(internal, /parsed\.body\?\.type === 'snapshot'/);
});
