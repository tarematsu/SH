import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { materializeDependencies } from '../src/ingest-channel-optimized-entry.js';

function config(name) {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

test('CPU budget keeps the 10 ms ceiling outside identified historical reconstruction', () => {
  const source = readFileSync(
    new URL('../../.github/scripts/enforce-worker-cpu-budget.py', import.meta.url),
    'utf8',
  );
  assert.match(source, /BUDGET_MS = 10\.0/);
  assert.match(source, /REBUILD_EVENT_MARKERS/);
  assert.match(source, /samples != budget_events/);
  assert.match(source, /float\(maximum\) > BUDGET_MS/);
  assert.match(source, /unobserved_active_workers\.append\(name\)/);
  assert.doesNotMatch(source, /"reason": "active_worker_unobserved"/);
  assert.match(source, /"comparison": "less_than_or_equal"/);
  assert.match(source, /"statistic": "max"/);
});

test('runtime preloads the live fact store before queue invocations', () => {
  const source = readFileSync(new URL('../src/runtime-orchestrator-entry.js', import.meta.url), 'utf8');
  assert.match(source, /import '\.\/minute-facts-fast-store\.js';/);
});

test('production ingest bounds comment work and defers duplicate metadata persistence', async () => {
  const ingest = config('wrangler.ingest.jsonc');
  const entry = readFileSync(new URL('../src/ingest-channel-optimized-entry.js', import.meta.url), 'utf8');
  assert.equal(ingest.vars.CHAT_LIMIT, 0);
  assert.equal(ingest.vars.COMMENT_CHAIN_MAX_ATTEMPTS, 1);
  assert.match(entry, /CHAT_LIMIT: \{ value: 25/);
  assert.equal(ingest.vars.METADATA_REFRESH_INTERVAL_MS, 1_800_000);
  assert.equal(ingest.vars.COLLECTED_METADATA_PERSIST_ENABLED, false);
  assert.equal(await materializeDependencies({}).collectedMetadataDue(), false);
});

test('retired runtime adapters and compatibility schedulers are physically absent', () => {
  for (const path of [
    '../../site/functions/lib/apple-music-d1-pruner.js',
    '../src/other-entry.js',
    '../src/other-entry-compat.js',
    '../src/other-monitor-support.js',
    '../src/other-monitor-entry.js',
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
  }
});
