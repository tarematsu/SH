import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const selector = fileURLToPath(new URL('../scripts/select-worker-deploys.mjs', import.meta.url));
const RUNTIME = 'sh-runtime-orchestrator';

function select(paths = [], args = []) {
  return JSON.parse(execFileSync(process.execPath, [selector, ...args], {
    encoding: 'utf8',
    input: `${paths.join('\n')}\n`,
  }));
}

test('domain modules map to the three active Workers', () => {
  assert.deepEqual(select(['worker/src/comments-entry.js']).workers, ['sh-buddies-ingest']);
  assert.deepEqual(select(['worker/src/persist-channel-entry.js']).workers, ['sh-buddies-ingest']);
  assert.deepEqual(select(['worker/src/minute-enrichment-entry.js']).workers, ['sh-minute-enrichment']);
  assert.deepEqual(select(['worker/src/track-metadata-entry.js']).workers, ['sh-minute-enrichment']);
  assert.deepEqual(select(['worker/src/read-model-entry.js']).workers, ['sh-minute-enrichment']);
  assert.deepEqual(select(['worker/src/minute-derive-entry.js']).workers, [RUNTIME]);
  assert.deepEqual(select(['worker/src/minute-rebuild-batched-entry.js']).workers, [RUNTIME]);
  assert.deepEqual(select(['worker/src/buddy-playback-entry.js']).workers, [RUNTIME]);
  assert.deepEqual(select(['worker/src/host-monitor-entry.js']).workers, [RUNTIME]);
  assert.deepEqual(select(['worker/src/runtime-queue.js']).workers, [RUNTIME]);
  assert.deepEqual(select(['worker/src/runtime-scheduled.js']).workers, [RUNTIME]);
});

test('deployment support changes select the owning Worker', () => {
  assert.deepEqual(select(['worker/scripts/deploy-runtime.mjs']), {
    changed_paths: ['worker/scripts/deploy-runtime.mjs'],
    workers: [RUNTIME],
    commands: ['deploy:runtime'],
    diagnostics: [RUNTIME],
  });
  assert.deepEqual(select(['worker/scripts/deploy-minute-enrichment.mjs']).workers, ['sh-minute-enrichment']);
  assert.deepEqual(select(['worker/scripts/deploy-ingest.mjs']).workers, ['sh-buddies-ingest']);
});

test('shared build configuration changes conservatively select every Worker', () => {
  for (const path of [
    'worker/package.json',
    'worker/package-lock.json',
    'worker/scripts/cloudflare-build-config.mjs',
    'worker/scripts/deploy-connected-worker.mjs',
  ]) {
    assert.equal(select([path]).workers.length, 3);
  }
});

test('Wrangler config changes map directly to their Worker', () => {
  assert.deepEqual(select(['worker/wrangler.minute-enrichment.jsonc']).workers, ['sh-minute-enrichment']);
  assert.deepEqual(select(['worker/wrangler.ingest.jsonc']).workers, ['sh-buddies-ingest']);
  assert.deepEqual(select(['worker/wrangler.runtime.jsonc']).workers, [RUNTIME]);
});

test('tests and unrelated verification scripts do not deploy Workers', () => {
  const result = select([
    'worker/tests/optional-comments.test.js',
    'worker/scripts/verify-facts-live.mjs',
  ]);
  assert.deepEqual(result.workers, []);
  assert.deepEqual(result.commands, []);
});

test('shared package and unresolved runtime source changes select all Workers', () => {
  assert.equal(select(['packages/sh-shared/index.mjs']).workers.length, 3);
  assert.equal(select(['worker/src/deleted-runtime-module.js']).workers.length, 3);
});

test('manual selection preserves dependency order', () => {
  const result = select([], ['--all']);
  assert.deepEqual(result.workers, [
    'sh-minute-enrichment',
    'sh-buddies-ingest',
    RUNTIME,
  ]);
  assert.deepEqual(result.commands, [
    'deploy:minute-enrichment',
    'deploy:ingest',
    'deploy:runtime',
  ]);
});
