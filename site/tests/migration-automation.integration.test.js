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

test('database workflow excludes the retired Pages migration operation', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /site-migrations/);
  assert.doesNotMatch(workflow, /stationhead-legacy/);
});

test('database workflow only auto-applies facts-db migrations, scoped to main and their own files', () => {
  assert.match(workflow, /if: github\.event_name == 'push' \|\| inputs\.operation == 'facts-db'/);
  const pushBlock = workflow.match(/^on:\n([\s\S]*?)\n(?:permissions:)/m)?.[1] || '';
  assert.match(pushBlock, /branches:\s*\n\s*- main/);
  assert.match(pushBlock, /paths:/);
});

test('retired Pages scripts delegate ownership to Worker database jobs', () => {
  assert.match(verifier, /Pages has no owned database/);
  assert.match(migrator, /Worker database provisioning is authoritative/);
  assert.doesNotMatch(migrator, /d1['"], ['"]migrations/);
  assert.doesNotMatch(verifier, /d1['"], ['"]execute/);
});
