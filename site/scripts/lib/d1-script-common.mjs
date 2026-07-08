import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_BRANCH = 'main';

export function cloudflareBuildContext() {
  const currentBranch = process.env.CF_PAGES_BRANCH || process.env.WORKERS_CI_BRANCH || '';
  return {
    currentBranch,
    cloudflareBuild: process.env.CF_PAGES === '1' || process.env.WORKERS_CI === '1',
    force: String(process.env.D1_MIGRATION_FORCE || '').toLowerCase() === 'true',
    production: currentBranch === PRODUCTION_BRANCH,
    branchSource: process.env.CF_PAGES_BRANCH ? 'CF_PAGES_BRANCH'
      : process.env.WORKERS_CI_BRANCH ? 'WORKERS_CI_BRANCH' : 'branch variable',
  };
}

export function skipNonProductionD1Step({ context, failurePrefix, skippedPrefix }) {
  if (context.force || context.production) return false;
  if (context.cloudflareBuild && !context.currentBranch) {
    console.error(`${failurePrefix}: Cloudflare build branch variable is missing.`);
    process.exit(1);
  }
  console.log(`${skippedPrefix}: ${context.branchSource}=${context.currentBranch || '(not set)'}`);
  process.exit(0);
}

export function scriptPaths(importMetaUrl) {
  const scriptDirectory = path.dirname(fileURLToPath(importMetaUrl));
  const siteDirectory = path.resolve(scriptDirectory, '..');
  const repositoryRoot = path.resolve(siteDirectory, '..');
  const wranglerConfigPath = path.join(siteDirectory, 'wrangler.jsonc');
  const wranglerExecutable = process.platform === 'win32'
    ? path.join(siteDirectory, 'node_modules', '.bin', 'wrangler.cmd')
    : path.join(siteDirectory, 'node_modules', '.bin', 'wrangler');
  return {
    scriptDirectory,
    siteDirectory,
    repositoryRoot,
    wranglerConfigPath,
    wranglerExecutable,
  };
}

export function assertWranglerInstalled(wranglerExecutable, message) {
  if (!existsSync(wranglerExecutable)) {
    console.error(message);
    process.exit(1);
  }
}

export function cloudflareCredentials() {
  return {
    apiToken: process.env.CLOUDFLARE_API_TOKEN
      || process.env.CLOUDFLARE_BUILDS_API_TOKEN
      || '',
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID
      || process.env.CF_ACCOUNT_ID
      || '',
  };
}

export function wranglerEnvironment({ apiToken = '', accountId = '' } = {}) {
  return {
    ...process.env,
    CI: 'true',
    ...(apiToken ? { CLOUDFLARE_API_TOKEN: apiToken } : {}),
    ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
  };
}

export function spawnWrangler({ executable, args, cwd, env, encoding = 'utf8', stdio }) {
  const options = {
    cwd,
    env,
    ...(stdio ? { stdio } : { encoding }),
  };
  const result = spawnSync(executable, args, options);
  if (result.error) throw result.error;
  return result;
}
