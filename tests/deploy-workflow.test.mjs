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
  assert.match(deployWorkflow, /npm run deploy:minute/);
  assert.equal(occurrences, 8);
});

test('legacy Cloudflare minute deploy typo routes to the canonical script', () => {
  assert.equal(workerPackage.scripts['deploy:mintue'], 'npm run deploy:minute');
  assert.match(workerPackage.scripts['deploy:minute'], /wrangler\.minute\.jsonc/);
});

test('Cloudflare Git diagnostics run automatically for connected Worker builds', () => {
  assert.match(diagnosticsWorkflow, /^\s{2}push:/m);
  assert.match(diagnosticsWorkflow, /branches: \[main\]/);
  assert.match(diagnosticsWorkflow, /sh-monitor-buddies/);
  assert.match(diagnosticsWorkflow, /sh-monitor-other/);
  assert.match(diagnosticsWorkflow, /sh-monitor-minute/);
  assert.match(diagnosticsWorkflow, /cloudflare-build-diagnostics\.mjs/);
});
