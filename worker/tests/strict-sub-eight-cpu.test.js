import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  resetAppleMusicRuntimeCachesForTests,
  withAppleMusicFreeRuntime,
} from '../../site/functions/lib/apple-music-d1-pruner.js';
import { officialNewsProbeDue } from '../src/other-monitor-support.js';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('CPU budget treats 8 ms itself as a violation', () => {
  const source = readFileSync(
    new URL('../../.github/scripts/enforce-worker-cpu-budget.py', import.meta.url),
    'utf8',
  );
  assert.match(source, /float\(p95\) >= BUDGET_MS/);
  assert.match(source, /"comparison": "strictly_less_than"/);
});

test('production configs bound comment work and metadata refresh frequency', () => {
  assert.equal(config('wrangler.comments.jsonc').vars.CHAT_LIMIT, 25);
  assert.equal(config('wrangler.ingest.jsonc').vars.METADATA_REFRESH_INTERVAL_MS, 1_800_000);
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
