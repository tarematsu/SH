import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function workflow(name) {
  return readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
}

function jobSection(source, name, nextName) {
  const start = source.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `${name} job must exist`);
  const end = nextName ? source.indexOf(`  ${nextName}:\n`, start + 1) : source.length;
  assert.notEqual(end, -1, `${nextName} job must exist after ${name}`);
  return source.slice(start, end);
}

const ci = workflow('ci.yml');
const productionDeploy = workflow('deploy-split-pipeline.yml');
const d1Usage = workflow('fetch-cloudflare-d1-usage.yml');
const observability = workflow('fetch-cloudflare-observability.yml');
const hourlyCpu = workflow('fetch-cloudflare-observability-hourly.yml');
const sitePackage = JSON.parse(readFileSync(new URL('../site/package.json', import.meta.url), 'utf8'));
const workerDependencyGuard = readFileSync(
  new URL('../site/scripts/ensure-worker-test-deps.mjs', import.meta.url),
  'utf8',
);

test('CI selects affected scopes and keeps repository checks free of Pages dependencies', () => {
  assert.match(ci, /^  changes:\n/m);
  assert.match(ci, /needs\.changes\.outputs\.pages == 'true'/);
  assert.match(ci, /needs\.changes\.outputs\.worker == 'true'/);
  assert.match(ci, /needs\.changes\.outputs\.sql == 'true'/);

  const repository = jobSection(ci, 'repository', 'pages');
  assert.match(repository, /uses: actions\/cache@v4/);
  assert.match(repository, /worker\/node_modules/);
  assert.match(repository, /npm ci --prefer-offline/);
  assert.doesNotMatch(repository, /site\/node_modules/);
  assert.doesNotMatch(repository, /working-directory: site/);
  assert.match(repository, /check-js-syntax\.mjs scripts tests/);
});

test('CI restores workspace dependencies and avoids the Pages pretest reinstall', () => {
  const pages = jobSection(ci, 'pages', 'worker');
  const worker = jobSection(ci, 'worker', 'audit');

  assert.match(pages, /uses: actions\/cache@v4/);
  assert.match(pages, /site\/node_modules/);
  assert.match(pages, /worker\/node_modules/);
  assert.match(pages, /node --test tests\/\*\.test\.js/);
  assert.doesNotMatch(pages, /npm run test:integration/);
  assert.match(pages, /cache-hit != 'true'/);

  assert.match(worker, /uses: actions\/cache@v4/);
  assert.match(worker, /worker\/node_modules/);
  assert.match(worker, /cache-hit != 'true'/);
});

test('Pages builds reuse Worker integration dependencies when inputs are unchanged', () => {
  assert.equal(
    sitePackage.scripts['pretest:integration'],
    'node scripts/ensure-worker-test-deps.mjs',
  );
  assert.match(workerDependencyGuard, /\.sh-worker-deps\.sha256/);
  assert.match(workerDependencyGuard, /package-lock\.json/);
  assert.match(workerDependencyGuard, /packages\/sh-shared/);
  assert.match(workerDependencyGuard, /Reusing cached Worker integration dependencies/);
  assert.match(workerDependencyGuard, /'ci', '--prefer-offline'/);
});

test('the single production deployment workflow caches Pages and Worker dependencies', () => {
  assert.match(productionDeploy, /^  push:\n/m);
  assert.match(productionDeploy, /^  workflow_dispatch:\n/m);
  assert.doesNotMatch(productionDeploy, /^  pull_request:\n/m);
  assert.match(productionDeploy, /uses: actions\/cache@v4/);
  assert.match(productionDeploy, /worker\/node_modules/);
  assert.match(productionDeploy, /worker-deploy-/);
  assert.match(productionDeploy, /site\/node_modules/);
  assert.match(productionDeploy, /pages-deploy-/);
  assert.match(productionDeploy, /npm ci --prefer-offline/);
});

test('production checks run only for runtime or schema changes', () => {
  for (const source of [d1Usage, observability, hourlyCpu]) {
    assert.doesNotMatch(source, /^\s*- ["']worker\/\*\*["']\s*$/m);
    assert.doesNotMatch(source, /^\s*- ["']\.github\/(?:workflows|scripts)\//m);
    assert.match(source, /worker\/src\/\*\*/);
    assert.match(source, /worker\/wrangler\*\.jsonc/);
  }
  assert.match(d1Usage, /worker-insights-/);
  assert.match(d1Usage, /uses: actions\/cache@v4/);
});
