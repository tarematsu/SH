import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  resetAppleMusicRuntimeCachesForTests,
  withAppleMusicFreeRuntime,
} from '../../site/functions/lib/apple-music-d1-pruner.js';
import { materializeDependencies } from '../src/ingest-channel-optimized-entry.js';
import { officialNewsProbeDue } from '../src/other-monitor-support.js';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('CPU budget requires a p95 strictly below 10 ms', () => {
  const source = readFileSync(
    new URL('../../.github/scripts/enforce-worker-cpu-budget.py', import.meta.url),
    'utf8',
  );
  assert.match(source, /BUDGET_MS = 10\.0/);
  assert.match(source, /float\(p95\) >= BUDGET_MS/);
  assert.match(source, /"comparison": "less_than"/);
});

test('production config bounds comment work and defers duplicate metadata persistence', async () => {
  const ingest = config('wrangler.ingest.jsonc');
  const entry = readFileSync(new URL('../src/ingest-channel-optimized-entry.js', import.meta.url), 'utf8');
  assert.equal(ingest.vars.CHAT_LIMIT, 0);
  assert.equal(ingest.vars.COMMENT_CHAIN_MAX_ATTEMPTS, 1);
  assert.match(entry, /CHAT_LIMIT: \{ value: 25/);
  assert.equal(ingest.vars.METADATA_REFRESH_INTERVAL_MS, 1_800_000);
  assert.equal(ingest.vars.COLLECTED_METADATA_PERSIST_ENABLED, false);
  assert.equal(await materializeDependencies({}).collectedMetadataDue(), false);
});

test('Apple-free runtime wrapper is reused for the same warm environment', () => {
  resetAppleMusicRuntimeCachesForTests();
  const env = {
    MINUTE_DB: { prepare() {} },
    MINUTE_ENRICHMENT_QUEUE: { send() {} },
  };
  assert.equal(withAppleMusicFreeRuntime(env), withAppleMusicFreeRuntime(env));
});

test('official-news due query is reused within one five-minute monitor slot', async () => {
  let queries = 0;
  const OTHER_DB = {
    prepare() {
      queries += 1;
      return {
        bind() { return this; },
        async first() { return { due: 1 }; },
      };
    },
  };
  const env = { OTHER_DB };
  assert.equal(await officialNewsProbeDue(env, 600_000), true);
  assert.equal(await officialNewsProbeDue(env, 600_100), true);
  assert.equal(queries, 1);
});
