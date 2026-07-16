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
  assert.match(deployWorkflow, /npm run deploy:read-model/);
  assert.match(deployWorkflow, /npm run deploy:other/);
  assert.match(deployWorkflow, /npm run deploy:minute-maintenance/);
  assert.match(deployWorkflow, /npm run retire:legacy-minute-maintenance/);
  assert.match(deployWorkflow, /npm run deploy:minute-derive/);
  assert.match(deployWorkflow, /npm run detach:minute-consumer/);
  assert.match(deployWorkflow, /npm run deploy:minute-ingest/);
  assert.match(deployWorkflow, /npm run deploy:minute/);
  assert.equal(occurrences, 14);
});

test('legacy Cloudflare minute deploy typo routes to the safe split canonical script', () => {
  assert.equal(workerPackage.scripts['deploy:mintue'], 'npm run deploy:minute');
  assert.match(workerPackage.scripts['deploy:minute'], /deploy:minute-derive/);
  assert.match(workerPackage.scripts['deploy:minute'], /detach:minute-consumer/);
  assert.match(workerPackage.scripts['deploy:minute'], /deploy:minute-maintenance/);
  assert.match(workerPackage.scripts['deploy:minute'], /retire:legacy-minute-maintenance/);
  assert.match(workerPackage.scripts['deploy:minute'], /deploy:minute-ingest/);
  assert.match(workerPackage.scripts['detach:minute-consumer'], /queues consumer remove stationhead-buddies-facts sh-monitor-minute/);
  assert.match(workerPackage.scripts['retire:legacy-minute-maintenance'], /retire-legacy-minute-maintenance\.mjs/);
  assert.match(workerPackage.scripts['deploy:minute-maintenance'], /wrangler\.minute\.jsonc/);
  assert.match(workerPackage.scripts['deploy:minute-derive'], /wrangler\.minute-derive\.jsonc/);
  assert.match(workerPackage.scripts['deploy:minute-ingest'], /wrangler\.minute-ingest\.jsonc/);
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
