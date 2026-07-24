import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const selector = fileURLToPath(new URL('../scripts/select-worker-deploys.mjs', import.meta.url));
const SAKURAZAKA = 'sh-sakurazaka46jp';
const COLLECTOR = 'sh-buddies-collector';
const RUNTIME = 'sh-runtime-orchestrator';

function select(paths = [], args = []) {
  return JSON.parse(execFileSync(process.execPath, [selector, ...args], {
    encoding: 'utf8',
    input: `${paths.join('\n')}\n`,
  }));
}

test('domain modules select every Worker whose bundle imports them', () => {
  assert.deepEqual(select(['worker/src/persist-channel-entry.js']).workers, [COLLECTOR, RUNTIME]);
  for (const path of [
    'worker/src/minute-enrichment-playback-stages.js',
    'worker/src/track-metadata-entry.js',
    'worker/src/pages-read-model-entry.js',
    'worker/src/minute-derive-entry.js',
    'worker/src/minute-rebuild-batched-entry.js',
    'worker/src/runtime-queue.js',
    'worker/src/runtime-scheduled.js',
  ]) {
    assert.deepEqual(select([path]).workers, [RUNTIME], path);
  }
  assert.deepEqual(select(['worker/src/buddies-collector-entry.js']).workers, [COLLECTOR]);
  assert.deepEqual(select(['worker/src/sakurazaka-monitor.js']).workers, [SAKURAZAKA]);
});

test('deployment support changes select the owning Worker', () => {
  assert.deepEqual(select(['worker/scripts/deploy-buddies-collector.mjs']), {
    changed_paths: ['worker/scripts/deploy-buddies-collector.mjs'],
    workers: [COLLECTOR],
    commands: ['deploy:buddies-collector'],
    diagnostics: [],
  });
  assert.deepEqual(select(['worker/scripts/deploy-runtime.mjs']), {
    changed_paths: ['worker/scripts/deploy-runtime.mjs'],
    workers: [RUNTIME],
    commands: ['deploy:runtime'],
    diagnostics: [RUNTIME],
  });
  assert.deepEqual(select(['worker/scripts/pages-response-kv-namespace.mjs']).workers, [RUNTIME]);
  assert.deepEqual(select(['worker/scripts/provision-runtime-analytics-pipeline.mjs']).workers, [RUNTIME]);
  assert.deepEqual(select(['worker/pipelines/runtime-analytics.sql']).workers, [RUNTIME]);
  assert.deepEqual(select(['worker/pipelines/runtime-analytics.schema.json']).workers, [RUNTIME]);
  assert.deepEqual(select(['worker/scripts/deploy-sakurazaka46jp.mjs']).workers, [SAKURAZAKA]);
});

test('MINUTE_DB schema changes deploy the runtime that consumes the schema', () => {
  for (const path of [
    'database/facts-db.json',
    'database/facts-migrations/039_reduce_fact_write_amplification.sql',
    'database/facts-migrations/040_sparse_live_metric_values.sql',
    'database/facts-migrations/041_restore_complete_live_metrics.sql',
  ]) {
    assert.deepEqual(select([path]).workers, [RUNTIME], path);
    assert.deepEqual(select([path]).commands, ['deploy:runtime'], path);
    assert.deepEqual(select([path]).diagnostics, [RUNTIME], path);
  }
});

test('shared deployment infrastructure selects all three Workers', () => {
  for (const path of [
    'worker/package.json',
    'worker/package-lock.json',
    'worker/scripts/cloudflare-build-config.mjs',
    'worker/scripts/cloudflare-queues.mjs',
    'worker/scripts/cloudflare-workers.mjs',
    'worker/scripts/deploy-connected-worker.mjs',
    'worker/scripts/select-worker-deploys.mjs',
    'worker/scripts/wrangler-command.mjs',
  ]) {
    assert.equal(select([path]).workers.length, 3, path);
  }
});

test('Wrangler config changes map directly to their Worker', () => {
  assert.deepEqual(select(['worker/wrangler.sakurazaka46jp.jsonc']).workers, [SAKURAZAKA]);
  assert.deepEqual(select(['worker/wrangler.buddies-collector.jsonc']).workers, [COLLECTOR]);
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

test('shared package and unresolved Worker source changes select all Workers', () => {
  assert.equal(select(['packages/sh-shared/index.mjs']).workers.length, 3);
  assert.equal(select(['worker/src/deleted-runtime-module.js']).workers.length, 3);
});

test('manual selection preserves dependency order', () => {
  const result = select([], ['--all']);
  assert.deepEqual(result.workers, [SAKURAZAKA, COLLECTOR, RUNTIME]);
  assert.deepEqual(result.commands, [
    'deploy:sakurazaka46jp',
    'deploy:buddies-collector',
    'deploy:runtime',
  ]);
});
