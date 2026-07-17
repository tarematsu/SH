import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const selector = new URL('../scripts/select-worker-deploys.mjs', import.meta.url);

function select(paths = [], args = []) {
  return JSON.parse(execFileSync(process.execPath, [selector.pathname, ...args], {
    encoding: 'utf8',
    input: `${paths.join('\n')}\n`,
  }));
}

test('comments-only changes do not redeploy the minute pipeline', () => {
  const result = select(['worker/src/comments-entry.js']);
  assert.deepEqual(result.workers, ['sh-buddies-comments']);
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

test('other monitor changes do not pull retired Pages or maintenance Workers back in', () => {
  const result = select(['worker/src/other-monitor-support.js']);
  assert.deepEqual(result.workers, ['sh-monitor-other']);
  assert.deepEqual(result.commands, ['deploy:other']);
  assert.deepEqual(result.diagnostics, ['sh-monitor-other']);
});

test('Wrangler config changes map directly to their Worker', () => {
  const result = select(['worker/wrangler.pages-read-model.jsonc']);
  assert.deepEqual(result.workers, ['sh-pages-read-model']);
  assert.deepEqual(result.commands, ['deploy:pages-read-model']);
});

test('deploy script-only package changes do not redeploy runtime Workers', () => {
  const result = select(['worker/package.json']);
  assert.deepEqual(result.workers, []);
  assert.deepEqual(result.commands, []);
});

test('lockfile changes conservatively redeploy every Worker', () => {
  const result = select(['worker/package-lock.json']);
  assert.equal(result.workers.length, 10);
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
  assert.ok(result.workers.includes('sh-buddies-monitor'));
  assert.ok(result.workers.includes('sh-buddies-ingest'));
  assert.ok(result.workers.includes('sh-buddies-comments'));
  assert.ok(result.workers.length >= 3);
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
