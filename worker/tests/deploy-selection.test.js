import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  connectedWorkerBuildWatchConfig,
  workerBuildWatchPaths,
} from '../scripts/select-worker-deploys.mjs';

const selector = new URL('../scripts/select-worker-deploys.mjs', import.meta.url);

function select(paths = [], args = []) {
  return JSON.parse(execFileSync(process.execPath, [selector.pathname, ...args], {
    encoding: 'utf8',
    input: `${paths.join('\n')}\n`,
  }));
}

test('comments-only changes do not redeploy the minute pipeline', () => {
  const result = select(['worker/src/comments-entry.js']);
  assert.deepEqual(result.workers, ['sh-comments']);
  assert.deepEqual(result.commands, ['deploy:comments']);
  assert.deepEqual(result.diagnostics, []);
});

test('minute derive changes redeploy only the derive consumer', () => {
  const result = select(['worker/src/minute-derive-entry.js']);
  assert.deepEqual(result.workers, ['sh-minute-derive']);
  assert.deepEqual(result.commands, ['deploy:minute-derive']);
});

test('bundled site function changes redeploy only the Pages materializer', () => {
  const result = select(['site/functions/api/minute-facts/current.js']);
  assert.deepEqual(result.workers, ['sh-pages-read-model']);
  assert.deepEqual(result.commands, ['deploy:pages-read-model']);
  assert.deepEqual(result.diagnostics, []);
});

test('Wrangler config changes map directly to their Worker', () => {
  const result = select(['worker/wrangler.pages-read-model.jsonc']);
  assert.deepEqual(result.workers, ['sh-pages-read-model']);
  assert.deepEqual(result.commands, ['deploy:pages-read-model']);
});

test('tests and verification scripts do not redeploy runtime Workers', () => {
  const result = select([
    'worker/tests/optional-comments.test.js',
    'worker/scripts/verify-facts-live.mjs',
  ]);
  assert.deepEqual(result.workers, []);
  assert.deepEqual(result.commands, []);
});

test('shared package changes select every Worker that imports sh-shared', () => {
  const result = select(['packages/sh-shared/index.mjs']);
  assert.ok(result.workers.includes('sh-monitor-buddies'));
  assert.ok(result.workers.includes('sh-ingest-channel'));
  assert.ok(result.workers.includes('sh-comments'));
  assert.ok(result.workers.length >= 3);
});

test('connected build watch paths are generated for the three Git-managed Workers', () => {
  const config = connectedWorkerBuildWatchConfig();
  assert.deepEqual(Object.keys(config), [
    'sh-monitor-buddies',
    'sh-monitor-other',
    'sh-minute-maintenance',
  ]);
  for (const paths of Object.values(config)) {
    assert.ok(paths.includes('worker/package.json'));
    assert.ok(paths.includes('worker/package-lock.json'));
    assert.ok(paths.includes('worker/scripts/select-cloudflare-build-config.mjs'));
    assert.equal(paths.includes('*'), false);
  }
});

test('other connected build excludes retired Pages and maintenance workloads', () => {
  const paths = workerBuildWatchPaths('sh-monitor-other');
  assert.ok(paths.includes('worker/src/other-entry.js'));
  assert.ok(paths.includes('worker/src/other-monitor-entry.js'));
  assert.ok(paths.includes('worker/src/other-monitor-support.js'));
  assert.ok(paths.includes('worker/src/other-entry-compat.js'));
  assert.equal(paths.includes('worker/src/other-legacy-entry.js'), false);
  assert.equal(paths.includes('worker/src/pages-read-model-refresh.js'), false);
  assert.equal(paths.includes('worker/src/scheduled-maintenance.js'), false);
  assert.equal(paths.includes('worker/src/snapshot-retention.js'), false);
  assert.equal(paths.some((path) => path.startsWith('site/functions/')), false);
});

test('unresolved runtime source changes fall back to all Workers', () => {
  const result = select(['worker/src/deleted-runtime-module.js']);
  assert.equal(result.workers.length, 10);
});

test('manual selection deploys all Workers in durable order', () => {
  const result = select([], ['--all']);
  assert.deepEqual(result.workers.slice(0, 4), [
    'sh-minute-derive',
    'sh-minute-maintenance',
    'sh-minute-ingest',
    'sh-minute-read-model',
  ]);
  assert.equal(result.workers.length, 10);
});
