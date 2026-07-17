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

function gitOutput(args, options = {}) {
  const exec = options.execFileSync || execFileSync;
  return String(exec('git', args, {
    cwd: options.repositoryRoot || repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
}

export function connectedDeployDecision(workerName, changedPaths, selectedWorkers) {
  const name = String(workerName || '').trim();
  if (name && !cloudflareBuildConfig(name)) {
    return { deploy: false, reason: 'unknown-worker-build', workerName: name };
  }
  if (!name) {
    return { deploy: true, reason: 'not-a-connected-worker-build', workerName: null };
  }
  if (!Array.isArray(changedPaths)) {
    return { deploy: true, reason: 'changed-files-unavailable', workerName: name };
  }
  if (changedPaths.length === 0) {
    return { deploy: true, reason: 'empty-or-root-diff', workerName: name };
  }
  if (!Array.isArray(selectedWorkers)) {
    return { deploy: true, reason: 'worker-selection-unavailable', workerName: name };
  }
  const affected = selectedWorkers.includes(name);
  return {
    deploy: affected,
    reason: affected ? 'worker-affected' : 'worker-unaffected',
    workerName: name,
  };
}

export function currentCommitChangedPaths(options = {}) {
  try {
    return normalizedLines(gitOutput([
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '--root',
      'HEAD',
    ], options));
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'connected_worker_diff_unavailable',
      error: String(error?.message || error).slice(0, 500),
    }));
    return null;
  }
}

export function gitHubRepositorySlug(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  const match = value.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function connectedRepositorySlug(options = {}) {
  if (options.repositorySlug) return String(options.repositorySlug).trim() || null;
  try {
    return gitHubRepositorySlug(gitOutput(['remote', 'get-url', 'origin'], options));
  } catch {
    return null;
  }
}

function connectedCommitSha(options = {}) {
  const configured = String(
    options.commitSha
    ?? process.env.WORKERS_CI_COMMIT_SHA
    ?? '',
  ).trim();
  if (configured) return configured;
  try {
    return gitOutput(['rev-parse', 'HEAD'], options);
  } catch {
    return null;
  }
}

export function connectedRepositoryIsShallow(options = {}) {
  if (typeof options.shallow === 'boolean') return options.shallow;
  try {
    return gitOutput(['rev-parse', '--is-shallow-repository'], options) === 'true';
  } catch {
    return false;
  }
}

export async function githubCommitChangedPaths(options = {}) {
  const repositorySlug = connectedRepositorySlug(options);
  const commitSha = connectedCommitSha(options);
  const activeFetch = options.fetch || globalThis.fetch;
  if (!repositorySlug || !commitSha || typeof activeFetch !== 'function') return null;

  try {
    const paths = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await activeFetch(
        `https://api.github.com/repos/${repositorySlug}/commits/${encodeURIComponent(commitSha)}?per_page=100&page=${page}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'stationhead-connected-worker-build',
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error(`GitHub commit API returned HTTP ${response.status}`);
      const payload = await response.json();
      const files = Array.isArray(payload?.files) ? payload.files : [];
      paths.push(...files.map(({ filename }) => filename));
      if (files.length < 100) break;
    }
    return normalizedLines(paths.join('\n'));
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'connected_worker_github_diff_unavailable',
      error: String(error?.message || error).slice(0, 500),
    }));
    return null;
  }
}

export async function connectedCommitChangedPaths(options = {}) {
  const localPaths = options.localPaths === undefined
    ? currentCommitChangedPaths(options)
    : options.localPaths;
  const shallow = connectedRepositoryIsShallow(options);
  if (!shallow && Array.isArray(localPaths) && localPaths.length > 0) return localPaths;
  const remotePaths = await githubCommitChangedPaths(options);
  return Array.isArray(remotePaths) && remotePaths.length > 0 ? remotePaths : localPaths;
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

export async function deployConnectedWorker(options = {}) {
  const workerName = String(options.workerName ?? process.env.WRANGLER_CI_OVERRIDE_NAME ?? '').trim();
  const workerConfig = cloudflareBuildConfig(workerName);
  if (workerName && !workerConfig) {
    const decision = { deploy: false, reason: 'unknown-worker-build', workerName };
    console.log(JSON.stringify({ event: 'connected_worker_deploy_decision', ...decision }));
    return decision;
  }

  const branch = String(options.branch ?? process.env.WORKERS_CI_BRANCH ?? '').trim();
  const productionBranch = String(options.productionBranch ?? 'main').trim() || 'main';
  if (workerConfig && branch && branch !== productionBranch) {
    const decision = {
      deploy: false,
      reason: 'non-production-branch',
      workerName,
      branch,
      productionBranch,
    };
    console.log(JSON.stringify({ event: 'connected_worker_deploy_decision', ...decision }));
    return decision;
  }

  const changedPaths = options.changedPaths === undefined
    ? await connectedCommitChangedPaths(options)
    : options.changedPaths;
  const selectedWorkers = options.selectedWorkers === undefined
    ? affectedWorkersForPaths(changedPaths, options)
    : options.selectedWorkers;
  const decision = connectedDeployDecision(workerName, changedPaths, selectedWorkers);

  console.log(JSON.stringify({
    event: 'connected_worker_deploy_decision',
    ...decision,
    branch: branch || null,
    production_branch: productionBranch,
    changed_paths: Array.isArray(changedPaths) ? changedPaths : null,
    affected_workers: Array.isArray(selectedWorkers) ? selectedWorkers : null,
  }));

  if (!decision.deploy) return decision;
  runWrangler(options.wranglerArgs || process.argv.slice(2), options);
  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await deployConnectedWorker();
}
