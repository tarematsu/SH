import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../../.github/workflows/database.yml', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const migrator = readFileSync(new URL('../scripts/apply-d1-migrations.mjs', import.meta.url), 'utf8');
const verifier = readFileSync(new URL('../scripts/verify-d1-schema.mjs', import.meta.url), 'utf8');

test('production build applies migrations and verifies the resulting schema', () => {
  assert.match(packageJson.scripts.build, /db:migrate/);
  assert.match(packageJson.scripts.build, /db:verify/);
  assert.ok(packageJson.scripts.build.indexOf('db:migrate') < packageJson.scripts.build.indexOf('db:verify'));
});

test('database workflow keeps site migrations as an explicit manual operation', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: inputs\.operation == 'site-migrations'/);
  assert.match(workflow, /site-migrations/);
  assert.match(workflow, /npm run db:migrate/);
  assert.match(workflow, /npm run db:verify/);
});

test('database workflow only auto-applies facts-db migrations, scoped to main and their own files', () => {
  assert.match(workflow, /if: github\.event_name == 'push' \|\| inputs\.operation == 'facts-db'/);
  const pushBlock = workflow.match(/^on:\n([\s\S]*?)\n(?:permissions:)/m)?.[1] || '';
  assert.match(pushBlock, /branches:\s*\n\s*- main/);
  assert.match(pushBlock, /paths:/);
});

test('migration and verification detect both Pages and Workers production branches', () => {
  for (const script of [migrator, verifier]) {
    assert.match(script, /CF_PAGES_BRANCH/);
    assert.match(script, /WORKERS_CI_BRANCH/);
    assert.match(script, /currentBranch/);
    assert.match(script, /main/);
    assert.match(script, /Cloudflare build branch variable is missing/);
  }
  assert.match(migrator, /currentBranch !== productionBranch/);
  assert.match(verifier, /currentBranch === 'main'/);
});

test('remote schema verification skips non-production builds unless forced', () => {
  assert.match(verifier, /D1_MIGRATION_FORCE/);
  assert.match(verifier, /verification skipped/);
});
