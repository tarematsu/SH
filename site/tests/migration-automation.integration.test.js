import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../../.github/workflows/database.yml', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const deployWorkflow = readFileSync(
  new URL('../../.github/workflows/deploy-split-pipeline.yml', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
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

test('production deploy owns automatic MINUTE_DB migration ordering', () => {
  assert.match(workflow, /if: inputs\.operation == 'minute-db'/);
  assert.match(workflow, /FACTS_DEPLOY_CHANGED_ONLY: 'true'/);
  assert.match(workflow, /DEPLOY_BASE_SHA:/);
  assert.match(workflow, /DEPLOY_HEAD_SHA:/);
  const pushBlock = workflow.match(/^on:\n([\s\S]*?)\n(?:permissions:)/m)?.[1] || '';
  assert.match(pushBlock, /branches:\s*\n\s*- main/);
  assert.match(pushBlock, /paths:/);
  assert.doesNotMatch(pushBlock, /database\/facts-migrations/);
  assert.match(deployWorkflow, /database\/facts-migrations\/\*\*/);
  assert.match(deployWorkflow, /operation: minute-db/);
  assert.match(deployWorkflow, /needs: \[select, minute_db\]/);
});

test('retired Pages scripts delegate ownership to Worker database jobs', () => {
  assert.match(verifier, /Pages has no owned database/);
  assert.match(migrator, /Worker database provisioning is authoritative/);
  assert.doesNotMatch(migrator, /d1['"], ['"]migrations/);
  assert.doesNotMatch(verifier, /d1['"], ['"]execute/);
});
