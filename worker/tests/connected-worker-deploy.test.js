import assert from 'node:assert/strict';
import test from 'node:test';

import {
  affectedWorkersForPaths,
  connectedCommitChangedPaths,
  connectedDeployDecision,
  deployConnectedWorker,
  gitHubRepositorySlug,
  githubCommitChangedPaths,
} from '../scripts/deploy-connected-worker.mjs';
import { WRANGLER_SCRIPT } from '../scripts/wrangler-command.mjs';

const RUNTIME = 'sh-runtime-orchestrator';
const SAKURAZAKA = 'sh-sakurazaka46jp';

test('connected deploy decision skips an unaffected runtime Worker', () => {
  assert.deepEqual(
    connectedDeployDecision(RUNTIME, ['worker/src/sakurazaka-monitor.js'], [SAKURAZAKA]),
    { deploy: false, reason: 'worker-unaffected', workerName: RUNTIME },
  );
});

test('unknown connected Worker names never deploy', async () => {
  const expected = {
    deploy: false,
    reason: 'unknown-worker-build',
    workerName: 'unknown-worker',
  };
  assert.deepEqual(connectedDeployDecision('unknown-worker', null, null), expected);
  let spawned = false;
  const result = await deployConnectedWorker({
    workerName: 'unknown-worker',
    spawnSync() { spawned = true; return { status: 0 }; },
  });
  assert.deepEqual(result, expected);
  assert.equal(spawned, false);
});

test('local deploy defaults to the runtime static config', async () => {
  const calls = [];
  const result = await deployConnectedWorker({
    workerName: '',
    wranglerArgs: ['--dry-run'],
    spawnSync(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0 };
    },
  });
  assert.deepEqual(result, {
    deploy: true,
    reason: 'local-runtime-default',
    workerName: RUNTIME,
  });
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    WRANGLER_SCRIPT,
    'deploy', '--config', 'wrangler.runtime.jsonc', '--dry-run',
  ]);
});

test('connected deploy decision keeps conservative fallbacks', () => {
  assert.equal(connectedDeployDecision(RUNTIME, null, null).deploy, true);
  assert.deepEqual(
    connectedDeployDecision(RUNTIME, ['worker/src/runtime-queue.js'], null),
    { deploy: true, reason: 'worker-selection-unavailable', workerName: RUNTIME },
  );
  assert.deepEqual(
    connectedDeployDecision('', ['worker/src/runtime-queue.js'], [RUNTIME]),
    { deploy: true, reason: 'not-a-connected-worker-build', workerName: null },
  );
});

test('GitHub repository slug accepts HTTPS and SSH remotes', () => {
  assert.equal(gitHubRepositorySlug('https://github.com/tarematsu/SH.git'), 'tarematsu/SH');
  assert.equal(gitHubRepositorySlug('git@github.com:tarematsu/SH.git'), 'tarematsu/SH');
  assert.equal(gitHubRepositorySlug('https://example.com/tarematsu/SH.git'), null);
});

test('GitHub commit fallback returns changed files for a shallow build', async () => {
  const requested = [];
  const paths = await githubCommitChangedPaths({
    repositorySlug: 'tarematsu/SH',
    commitSha: 'abc123',
    fetch: async (url) => {
      requested.push(url);
      return {
        ok: true,
        async json() {
          return { files: [
            { filename: 'worker/src/runtime-queue.js' },
            { filename: 'worker/src/runtime-scheduled.js' },
          ] };
        },
      };
    },
  });
  assert.deepEqual(paths, ['worker/src/runtime-queue.js', 'worker/src/runtime-scheduled.js']);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /repos\/tarematsu\/SH\/commits\/abc123/);
});

test('shallow builds prefer GitHub commit files over a root-like local diff', async () => {
  const paths = await connectedCommitChangedPaths({
    localPaths: ['worker/src/production-entry.js', 'worker/src/runtime-queue.js'],
    shallow: true,
    repositorySlug: 'tarematsu/SH',
    commitSha: 'abc123',
    fetch: async () => ({
      ok: true,
      async json() { return { files: [{ filename: 'worker/src/runtime-queue.js' }] }; },
    }),
  });
  assert.deepEqual(paths, ['worker/src/runtime-queue.js']);
});

test('connected deploy guard uses the repository import graph', () => {
  assert.deepEqual(affectedWorkersForPaths(['worker/src/runtime-queue.js']), [RUNTIME]);
});

test('non-production connected build exits before Wrangler', async () => {
  let spawned = false;
  const result = await deployConnectedWorker({
    workerName: RUNTIME,
    branch: 'agent/test-fix',
    productionBranch: 'main',
    spawnSync() { spawned = true; return { status: 0 }; },
  });
  assert.deepEqual(result, {
    deploy: false,
    reason: 'non-production-branch',
    workerName: RUNTIME,
    branch: 'agent/test-fix',
    productionBranch: 'main',
  });
  assert.equal(spawned, false);
});

test('unaffected connected build exits without invoking Wrangler', async () => {
  let spawned = false;
  const result = await deployConnectedWorker({
    workerName: RUNTIME,
    changedPaths: ['worker/src/sakurazaka-monitor.js'],
    selectedWorkers: [SAKURAZAKA],
    spawnSync() { spawned = true; return { status: 0 }; },
  });
  assert.equal(result.deploy, false);
  assert.equal(spawned, false);
});

test('affected connected build invokes Wrangler with the static config', async () => {
  const calls = [];
  const result = await deployConnectedWorker({
    workerName: RUNTIME,
    changedPaths: ['worker/src/runtime-queue.js'],
    selectedWorkers: [RUNTIME],
    wranglerArgs: ['--dry-run'],
    spawnSync(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0 };
    },
  });
  assert.equal(result.deploy, true);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    WRANGLER_SCRIPT,
    'deploy', '--config', 'wrangler.runtime.jsonc', '--dry-run',
  ]);
});
