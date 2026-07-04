import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../../.github/workflows/apply-d1-migrations.yml', import.meta.url), 'utf8');
const migrator = readFileSync(new URL('../scripts/apply-d1-migrations.mjs', import.meta.url), 'utf8');
const verifier = readFileSync(new URL('../scripts/verify-d1-schema.mjs', import.meta.url), 'utf8');

test('production build applies migrations and verifies the resulting schema', () => {
  assert.match(packageJson.scripts.build, /db:migrate/);
  assert.match(packageJson.scripts.build, /db:verify/);
  assert.ok(packageJson.scripts.build.indexOf('db:migrate') < packageJson.scripts.build.indexOf('db:verify'));
});

test('GitHub migration workflow is manual fallback and cannot race Cloudflare builds', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s+push:/);
});

test('migration and verification detect both Pages and Workers production branches', () => {
  for (const script of [migrator, verifier]) {
    assert.match(script, /CF_PAGES_BRANCH/);
    assert.match(script, /WORKERS_CI_BRANCH/);
    assert.match(script, /currentBranch === 'main'/);
    assert.match(script, /Cloudflare build branch variable is missing/);
  }
});

test('remote schema verification skips non-production builds unless forced', () => {
  assert.match(verifier, /D1_MIGRATION_FORCE/);
  assert.match(verifier, /verification skipped/);
});
