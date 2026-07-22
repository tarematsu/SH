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
const deploy = workflow('deploy.yml');
const splitDeploy = workflow('deploy-split-pipeline.yml');
const prDiagnostics = workflow('cloudflare-pr-diagnostics.yml');
const d1Usage = workflow('fetch-cloudflare-d1-usage.yml');
const observability = workflow('fetch-cloudflare-observability.yml');
const hourlyCpu = workflow('fetch-cloudflare-observability-hourly.yml');

test('CI selects affected scopes and keeps repository checks dependency-free', () => {
  assert.match(ci, /^  changes:\n/m);
  assert.match(ci, /needs\.changes\.outputs\.pages == 'true'/);
  assert.match(ci, /needs\.changes\.outputs\.worker == 'true'/);
  assert.match(ci, /needs\.changes\.outputs\.sql == 'true'/);

  const repository = jobSection(ci, 'repository', 'pages');
  assert.doesNotMatch(repository, /npm ci/);
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

test('manual, automatic, and PR Worker deploys reuse cached dependencies', () => {
  for (const source of [deploy, splitDeploy, prDiagnostics]) {
    assert.match(source, /uses: actions\/cache@v4/);
    assert.match(source, /worker\/node_modules/);
    assert.match(source, /worker-deploy-/);
    assert.match(source, /npm ci --prefer-offline/);
  }
  assert.match(deploy, /site\/node_modules/);
  assert.match(deploy, /pages-deploy-/);
});

test('production telemetry does not run for arbitrary Worker test changes', () => {
  for (const source of [d1Usage, observability, hourlyCpu]) {
    assert.doesNotMatch(source, /^\s*- ["']worker\/\*\*["']\s*$/m);
    assert.match(source, /worker\/src\/\*\*/);
    assert.match(source, /worker\/wrangler\*\.jsonc/);
  }
  assert.match(d1Usage, /worker-insights-/);
  assert.match(d1Usage, /uses: actions\/cache@v4/);
});
