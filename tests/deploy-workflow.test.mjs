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
const prDiagnosticsWorkflow = readFileSync(
  new URL('../.github/workflows/cloudflare-pr-diagnostics.yml', import.meta.url),
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

const selectorName = 'select-worker-deploys.mjs';

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

test('automatic deploys select affected Workers instead of redeploying the topology', () => {
  for (const workflow of [splitDeployWorkflow, prDiagnosticsWorkflow]) {
    assert.match(workflow, new RegExp(selectorName.replace('.', '\\.')));
    assert.match(workflow, /site\/functions\/\*\*/);
    assert.match(workflow, /packages\/sh-shared\/\*\*/);
    assert.match(workflow, /DEPLOY_COMMANDS/);
    assert.match(workflow, /npm run "\$command"/);
  }

  assert.match(splitDeployWorkflow, /workflow_dispatch/);
  assert.match(splitDeployWorkflow, /select-worker-deploys\.mjs --all/);
  assert.match(prDiagnosticsWorkflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(prDiagnosticsWorkflow, /fromJSON\(needs\.select-workers\.outputs\.diagnostics\)/);
});

test('minute cutover scripts remain available for explicit topology operations', () => {
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

test('Cloudflare Git diagnostics include shared Worker dependencies', () => {
  assert.match(diagnosticsWorkflow, /^\s{2}push:/m);
  assert.match(diagnosticsWorkflow, /branches: \[main\]/);
  assert.match(diagnosticsWorkflow, /packages\/sh-shared/);
  assert.match(diagnosticsWorkflow, /sh-monitor-buddies/);
  assert.match(diagnosticsWorkflow, /sh-monitor-other/);
  assert.match(diagnosticsWorkflow, /sh-minute-maintenance/);
  assert.doesNotMatch(diagnosticsWorkflow, /add_worker 'sh-monitor-minute'/);
  assert.match(diagnosticsWorkflow, /cloudflare-build-diagnostics\.mjs/);
});
