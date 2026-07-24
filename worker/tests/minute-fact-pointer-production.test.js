import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function config(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

test('production sends complete minute facts without pointer staging', () => {
  const collector = config('../wrangler.buddies-collector.jsonc');
  const runtime = config('../wrangler.runtime.jsonc');

  assert.equal(collector.vars.MINUTE_FACT_POINTER_QUEUE_ENABLED, false);
  assert.equal(runtime.vars.MINUTE_FACT_POINTER_QUEUE_ENABLED, false);
});
