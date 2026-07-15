import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const credentialKeys = [
  ['CLOUDFLARE', 'API', 'TOKEN'].join('_'),
  ['CLOUDFLARE', 'BUILDS', 'API', 'TOKEN'].join('_'),
  ['CLOUDFLARE', 'ACCOUNT', 'ID'].join('_'),
  ['CF', 'ACCOUNT', 'ID'].join('_'),
];

function run(script) {
  const env = { ...process.env, CF_PAGES: '1', CF_PAGES_BRANCH: 'main' };
  for (const key of credentialKeys) delete env[key];
  return spawnSync(process.execPath, [path.join(siteRoot, 'scripts', script)], {
    cwd: siteRoot,
    env,
    encoding: 'utf8',
  });
}

test('Pages build skips retired migration instead of targeting an orphaned database', () => {
  const result = run('apply-d1-migrations.mjs');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /D1 migrations skipped: Pages has no owned database/);
});

test('Pages build skips retired verification instead of targeting an orphaned database', () => {
  const result = run('verify-d1-schema.mjs');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /D1 schema verification skipped: Pages has no owned database/);
});
