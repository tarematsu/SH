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

test('connected deploy decision skips an unaffected Worker', () => {
  assert.deepEqual(
    connectedDeployDecision(
      'sh-monitor-buddies',
      ['worker/src/other-monitor-entry.js'],
      ['sh-monitor-other'],
    ),
    {
      deploy: false,
      reason: 'worker-unaffected',
      workerName: 'sh-monitor-buddies',
    },
  );
});

test('connected deploy decision keeps conservative fallbacks', () => {
  assert.equal(
    connectedDeployDecision('sh-monitor-buddies', null, null).deploy,
    true,
  );
  assert.deepEqual(
    connectedDeployDecision(
      'sh-monitor-buddies',
      ['worker/src/other-monitor-entry.js'],
      null,
    ),
    {
      deploy: true,
      reason: 'worker-selection-unavailable',
      workerName: 'sh-monitor-buddies',
    },
  );
  assert.equal(
    connectedDeployDecision('', ['worker/src/other-monitor-entry.js'], ['sh-monitor-other']).deploy,
    true,
  );
});

test('GitHub repository slug accepts HTTPS and SSH remotes', () => {
  assert.equal(gitHubRepositorySlug('https://github.com/tarematsu/SH.git'), 'tarematsu/SH');
  assert.equal(gitHubRepositorySlug('git@github.com:tarematsu/SH.git'), 'tarematsu/SH');
  assert.equal(gitHubRepositorySlug('https://example.com/tarematsu/SH.git'), null);
});

test('GitHub commit fallback returns the real changed files for a shallow build', async () => {
  const requested = [];
  const paths = await githubCommitChangedPaths({
    repositorySlug: 'tarematsu/SH',
    commitSha: 'abc123',
    fetch: async (url) => {
      requested.push(url);
      return {
        ok: true,
        async json() {
          return {
            files: [
              { filename: 'worker/src/other-monitor-entry.js' },
              { filename: 'worker/src/other-monitor-support.js' },
            ],
          };
        },
      };
    },
  });

  assert.deepEqual(paths, [
    'worker/src/other-monitor-entry.js',
    'worker/src/other-monitor-support.js',
  ]);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /repos\/tarematsu\/SH\/commits\/abc123/);
});

test('shallow builds prefer GitHub commit files over a root-like local diff', async () => {
  const paths = await connectedCommitChangedPaths({
    localPaths: ['worker/src/production-entry.js', 'worker/src/other-monitor-entry.js'],
    shallow: true,
    repositorySlug: 'tarematsu/SH',
    commitSha: 'abc123',
    fetch: async () => ({
      ok: true,
      async json() {
        return { files: [{ filename: 'worker/src/other-monitor-entry.js' }] };
      },
    }),
  });

  assert.deepEqual(paths, ['worker/src/other-monitor-entry.js']);
});

test('connected deploy guard uses the repository import graph', () => {
  const selected = affectedWorkersForPaths(['worker/src/other-monitor-support.js']);
  assert.deepEqual(selected, ['sh-monitor-other']);
});

test('unaffected connected build exits without invoking Wrangler', async () => {
  let spawned = false;
  const result = await deployConnectedWorker({
    workerName: 'sh-monitor-buddies',
    changedPaths: ['worker/src/other-monitor-entry.js'],
    selectedWorkers: ['sh-monitor-other'],
    spawnSync() {
      spawned = true;
      return { status: 0 };
    },
  });

  assert.equal(result.deploy, false);
  assert.equal(spawned, false);
});

test('affected connected build invokes Wrangler deploy', async () => {
  const calls = [];
  const result = await deployConnectedWorker({
    workerName: 'sh-monitor-other',
    changedPaths: ['worker/src/other-monitor-entry.js'],
    selectedWorkers: ['sh-monitor-other'],
    wranglerArgs: ['--dry-run'],
    spawnSync(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0 };
    },
  });

  assert.equal(result.deploy, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['deploy', '--dry-run']);
});
