import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cloudflareBuildConfig } from './select-cloudflare-build-config.mjs';

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(workerRoot, '..');
const selectorPath = resolve(workerRoot, 'scripts', 'select-worker-deploys.mjs');

function normalizedLines(value) {
  return [...new Set(String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter(Boolean))];
}

export function connectedDeployDecision(workerName, changedPaths, selectedWorkers) {
  const name = String(workerName || '').trim();
  if (!cloudflareBuildConfig(name)) {
    return { deploy: true, reason: 'not-a-connected-worker-build', workerName: name || null };
  }
  if (!Array.isArray(changedPaths)) {
    return { deploy: true, reason: 'changed-files-unavailable', workerName: name };
  }
  if (changedPaths.length === 0) {
    return { deploy: true, reason: 'empty-or-root-diff', workerName: name };
  }
  const affected = Array.isArray(selectedWorkers) ? selectedWorkers.includes(name) : false;
  return {
    deploy: affected,
    reason: affected ? 'worker-affected' : 'worker-unaffected',
    workerName: name,
  };
}

export function currentCommitChangedPaths(options = {}) {
  const exec = options.execFileSync || execFileSync;
  try {
    const output = exec('git', [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '--root',
      'HEAD',
    ], {
      cwd: options.repositoryRoot || repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return normalizedLines(output);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'connected_worker_diff_unavailable',
      error: String(error?.message || error).slice(0, 500),
    }));
    return null;
  }
}

export function affectedWorkersForPaths(changedPaths, options = {}) {
  if (!Array.isArray(changedPaths)) return null;
  const exec = options.execFileSync || execFileSync;
  try {
    const output = exec(process.execPath, [options.selectorPath || selectorPath], {
      cwd: options.repositoryRoot || repositoryRoot,
      encoding: 'utf8',
      input: `${changedPaths.join('\n')}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const payload = JSON.parse(output);
    return Array.isArray(payload?.workers) ? payload.workers : null;
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'connected_worker_selection_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return null;
  }
}

function runWrangler(args = [], options = {}) {
  const executable = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
  const result = (options.spawnSync || spawnSync)(executable, ['deploy', ...args], {
    cwd: options.workerRoot || workerRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`wrangler deploy terminated by ${result.signal}`);
  if (Number(result.status) !== 0) process.exitCode = Number(result.status) || 1;
}

export function deployConnectedWorker(options = {}) {
  const workerName = String(options.workerName ?? process.env.WRANGLER_CI_OVERRIDE_NAME ?? '').trim();
  const changedPaths = options.changedPaths === undefined
    ? currentCommitChangedPaths(options)
    : options.changedPaths;
  const selectedWorkers = options.selectedWorkers === undefined
    ? affectedWorkersForPaths(changedPaths, options)
    : options.selectedWorkers;
  const decision = connectedDeployDecision(workerName, changedPaths, selectedWorkers);

  console.log(JSON.stringify({
    event: 'connected_worker_deploy_decision',
    ...decision,
    changed_paths: Array.isArray(changedPaths) ? changedPaths : null,
    affected_workers: Array.isArray(selectedWorkers) ? selectedWorkers : null,
  }));

  if (!decision.deploy) return decision;
  runWrangler(options.wranglerArgs || process.argv.slice(2), options);
  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  deployConnectedWorker();
}
