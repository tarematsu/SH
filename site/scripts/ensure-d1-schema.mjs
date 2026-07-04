import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const force = String(process.env.D1_MIGRATION_FORCE || '').toLowerCase() === 'true';
const production = process.env.CF_PAGES_BRANCH === 'main';

export function hasMigrationRelevantChanges(paths = []) {
  return paths.some((value) => {
    const file = String(value || '').replaceAll('\\', '/');
    return file.startsWith('database/migrations/')
      || file === 'site/wrangler.jsonc'
      || file === 'site/scripts/apply-d1-migrations.mjs'
      || file === 'site/scripts/verify-d1-schema.mjs'
      || file === 'site/scripts/ensure-d1-schema.mjs';
  });
}

function changedFiles() {
  const commit = String(process.env.CF_PAGES_COMMIT_SHA || '').trim();
  if (!commit) return null;
  const result = spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', commit], {
    cwd: path.resolve(siteDirectory, '..'),
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function runScript(name) {
  const result = spawnSync(process.execPath, [path.join(siteDirectory, 'scripts', name)], {
    cwd: siteDirectory,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}

if (!force && !production) {
  console.log(`D1 schema ensure skipped: CF_PAGES_BRANCH=${process.env.CF_PAGES_BRANCH || '(not set)'}`);
} else {
  const files = changedFiles();
  const applyFirst = force || files == null || hasMigrationRelevantChanges(files);
  let status = 1;
  if (!applyFirst) {
    status = runScript('verify-d1-schema.mjs');
    if (status === 0) {
      console.log('Remote D1 schema is current; migration apply skipped.');
    } else {
      console.warn('Remote D1 schema verification failed; attempting pending migrations.');
    }
  }
  if (applyFirst || status !== 0) {
    status = runScript('apply-d1-migrations.mjs');
    if (status === 0) status = runScript('verify-d1-schema.mjs');
  }
  process.exitCode = status;
}
