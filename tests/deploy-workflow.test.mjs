import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const deployWorkflow = readFileSync(
  new URL('../.github/workflows/deploy.yml', import.meta.url),
  'utf8',
);
const diagnosticsWorkflow = readFileSync(
  new URL('../.github/workflows/cloudflare-build-diagnostics.yml', import.meta.url),
  'utf8',
);
const splitDeployWorkflow = readFileSync(
  new URL('../.github/workflows/deploy-split-pipeline.yml', import.meta.url),
  'utf8',
);
const workerPackage = JSON.parse(readFileSync(
  new URL('../worker/package.json', import.meta.url),
  'utf8',
));

test('manual deploy keeps all Cloudflare targets available', () => {
  const fallback = 'secrets.CLOUDFLARE_BUILDS_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN || secrets.CF_API_TOKEN';
  const occurrences = deployWorkflow.split(fallback).length - 1;

  assert.match(deployWorkflow, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(deployWorkflow, /^\s{2}push:/m);
  assert.match(deployWorkflow, /wrangler pages deploy/);
  assert.match(deployWorkflow, /npm run deploy:buddies/);
  assert.match(deployWorkflow, /npm run deploy:ingest/);
  assert.match(deployWorkflow, /npm run deploy:comments/);
  assert.match(deployWorkflow, /npm run deploy:minute/);
  assert.match(deployWorkflow, /npm run deploy:split-other/);
  assert.equal(occurrences, 3);
});

test('split deploy uses safe read-model and maintenance cutovers', () => {
  assert.match(splitDeployWorkflow, /npm run deploy:minute/);
  assert.match(splitDeployWorkflow, /npm run deploy:pages-read-model/);
  assert.match(splitDeployWorkflow, /npm run deploy:monitor-maintenance/);
  assert.match(splitDeployWorkflow, /npm run deploy:other/);

  assert.equal(workerPackage.scripts['deploy:mintue'], 'npm run deploy:minute');
  assert.match(workerPackage.scripts['deploy:minute'], /deploy:minute-derive/);
  assert.match(workerPackage.scripts['deploy:minute'], /detach:minute-consumer/);
  assert.match(workerPackage.scripts['deploy:minute'], /deploy:minute-maintenance/);
  assert.match(workerPackage.scripts['deploy:minute'], /retire:legacy-minute-maintenance/);
  assert.match(workerPackage.scripts['deploy:minute'], /deploy:minute-ingest/);
  assert.match(workerPackage.scripts['deploy:minute'], /deploy:minute-read-model-cutover/);
  assert.match(workerPackage.scripts['deploy:minute-read-model-cutover'], /detach:legacy-read-model-consumer/);
  assert.match(workerPackage.scripts['deploy:minute-read-model-cutover'], /deploy:minute-read-model/);
  assert.match(workerPackage.scripts['deploy:minute-read-model-cutover'], /retire:legacy-read-model/);
  assert.match(workerPackage.scripts['detach:legacy-read-model-consumer'], /stationhead-read-model sh-read-model/);
  assert.match(workerPackage.scripts['retire:legacy-read-model'], /retire-legacy-read-model\.mjs/);
  assert.match(workerPackage.scripts['deploy:split-other'], /deploy:pages-read-model/);
  assert.match(workerPackage.scripts['deploy:split-other'], /deploy:monitor-maintenance/);
  assert.match(workerPackage.scripts['deploy:split-other'], /deploy:other/);
});

test('Cloudflare Git diagnostics run automatically for connected Worker builds', () => {
  assert.match(diagnosticsWorkflow, /^\s{2}push:/m);
  assert.match(diagnosticsWorkflow, /branches: \[main\]/);
  assert.match(diagnosticsWorkflow, /sh-monitor-buddies/);
  assert.match(diagnosticsWorkflow, /sh-monitor-other/);
  assert.match(diagnosticsWorkflow, /sh-minute-maintenance/);
  assert.doesNotMatch(diagnosticsWorkflow, /add_worker 'sh-monitor-minute'/);
  assert.match(diagnosticsWorkflow, /cloudflare-build-diagnostics\.mjs/);
});
