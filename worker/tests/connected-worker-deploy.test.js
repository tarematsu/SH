import assert from 'node:assert/strict';
import test from 'node:test';

import {
  affectedWorkersForPaths,
  connectedDeployDecision,
  deployConnectedWorker,
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
  assert.equal(
    connectedDeployDecision('', ['worker/src/other-monitor-entry.js'], ['sh-monitor-other']).deploy,
    true,
  );
});

test('connected deploy guard uses the repository import graph', () => {
  const selected = affectedWorkersForPaths(['worker/src/other-monitor-support.js']);
  assert.deepEqual(selected, ['sh-monitor-other']);
});

test('unaffected connected build exits without invoking Wrangler', () => {
  let spawned = false;
  const result = deployConnectedWorker({
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

test('affected connected build invokes Wrangler deploy', () => {
  const calls = [];
  const result = deployConnectedWorker({
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
