import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const deploymentWorkflow = readFileSync(
  new URL('../.github/workflows/deploy-split-pipeline.yml', import.meta.url),
  'utf8',
);
const databaseWorkflow = readFileSync(
  new URL('../.github/workflows/database.yml', import.meta.url),
  'utf8',
);
const observabilityAnalyzer = readFileSync(
  new URL('../.github/scripts/analyze-worker-observability.py', import.meta.url),
  'utf8',
);
const workerPackage = JSON.parse(readFileSync(
  new URL('../worker/package.json', import.meta.url),
  'utf8',
));

const splitQueues = [
  'stationhead-buddies-persist',
  'stationhead-ingest-finalize',
  'stationhead-track-metadata',
  'stationhead-minute-enrichment',
  'stationhead-minute-rebuild',
  'stationhead-sakurazaka46jp',
  'stationhead-host-monitor',
  'stationhead-pages-read-model-publication',
  'stationhead-read-model',
];

const removedCloudflareGitFiles = [
  '../.github/workflows/cloudflare-build-diagnostics.yml',
  '../.github/workflows/cloudflare-pr-diagnostics.yml',
  '../.github/workflows/deploy.yml',
  '../.github/workflows/verify-production-facts.yml',
  '../.github/scripts/cloudflare-build-diagnostics.mjs',
];

test('one GitHub Actions workflow owns automatic and manual production deployments', () => {
  assert.match(deploymentWorkflow, /^name: Deploy production$/m);
  assert.match(deploymentWorkflow, /^  push:$/m);
  assert.match(deploymentWorkflow, /branches: \[main\]/);
  assert.match(deploymentWorkflow, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(deploymentWorkflow, /^  pull_request:$/m);

  for (const target of ['pages', 'workers', 'ingest', 'minute-enrichment', 'sakurazaka46jp', 'runtime']) {
    assert.match(deploymentWorkflow, new RegExp(`- ${target}`));
  }
  for (const command of [
    'deploy:ingest',
    'deploy:minute-enrichment',
    'deploy:sakurazaka46jp',
    'deploy:runtime',
  ]) {
    assert.match(deploymentWorkflow, new RegExp(command));
  }

  assert.match(deploymentWorkflow, /name: Deploy affected Workers/);
  assert.match(deploymentWorkflow, /name: Build and deploy Pages/);
  assert.match(deploymentWorkflow, /wrangler pages deploy public --project-name skrzk --branch main/);
  assert.match(deploymentWorkflow, /needs: \[select, workers\]/);
  assert.match(deploymentWorkflow, /needs\.workers\.result == 'success' \|\| needs\.workers\.result == 'skipped'/);
});

test('automatic production deploy selects affected Workers and Pages from changed files', () => {
  assert.match(deploymentWorkflow, /select-worker-deploys\.mjs/);
  assert.match(deploymentWorkflow, /site\/functions\/\*\*/);
  assert.match(deploymentWorkflow, /site\/public\/\*\*/);
  assert.match(deploymentWorkflow, /site\/wrangler\.jsonc/);
  assert.match(deploymentWorkflow, /packages\/sh-shared/);
  assert.match(deploymentWorkflow, /DEPLOY_COMMANDS/);
  assert.match(deploymentWorkflow, /npm run "\$command"/);
  assert.match(deploymentWorkflow, /select-worker-deploys\.mjs --all/);
  assert.doesNotMatch(deploymentWorkflow, /sync-cloudflare-build-watch-paths/);
});

test('Cloudflare Git build and PR production deployment files remain deleted', () => {
  for (const path of removedCloudflareGitFiles) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} must remain deleted`);
  }
  assert.match(databaseWorkflow, /name: Verify live data/);
  assert.match(databaseWorkflow, /node scripts\/verify-facts-live\.mjs/);
});

test('the production Worker deployment provisions current Queue boundaries', () => {
  for (const queue of splitQueues) {
    assert.match(deploymentWorkflow, new RegExp(`${queue} ${queue}-dlq`));
  }
});

test('Worker package scripts contain only active deployment and bundle operations', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(workerPackage.scripts).filter(([name]) => name.startsWith('deploy'))),
    {
      deploy: 'node scripts/deploy-connected-worker.mjs',
      'deploy:ingest': 'node scripts/deploy-ingest.mjs',
      'deploy:minute-enrichment': 'node scripts/deploy-minute-enrichment.mjs',
      'deploy:sakurazaka46jp': 'node scripts/deploy-sakurazaka46jp.mjs',
      'deploy:runtime': 'node scripts/deploy-runtime.mjs',
    },
  );
  assert.equal(workerPackage.scripts.postinstall, undefined);
  assert.equal(workerPackage.scripts['check:ingest-bundle'] !== undefined, true);
  assert.equal(workerPackage.scripts['check:minute-enrichment-bundle'] !== undefined, true);
  assert.equal(workerPackage.scripts['check:sakurazaka46jp-bundle'] !== undefined, true);
  assert.equal(workerPackage.scripts['check:runtime-bundle'] !== undefined, true);

  for (const path of [
    '../worker/wrangler.jsonc',
    '../worker/wrangler.other.jsonc',
    '../worker/wrangler.minute.jsonc',
    '../worker/wrangler.persist.jsonc',
    '../worker/wrangler.comments.jsonc',
    '../worker/wrangler.minute-derive.jsonc',
    '../worker/wrangler.minute-rebuild.jsonc',
    '../worker/wrangler.minute-ingest.jsonc',
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} must remain deleted`);
  }
});

test('observability requires active Workers and tolerates retired names during cleanup', () => {
  for (const worker of [
    'sh-buddies-ingest',
    'sh-minute-enrichment',
    'sh-sakurazaka46jp',
    'sh-runtime-orchestrator',
  ]) {
    assert.match(observabilityAnalyzer, new RegExp(worker));
  }
  for (const retired of [
    'sh-monitor-other',
    'sh-pages-read-model',
    'sh-minute-derive',
    'sh-host-monitor',
  ]) {
    assert.match(observabilityAnalyzer, new RegExp(retired));
  }
  assert.match(observabilityAnalyzer, /CPUTimeMs/);
  assert.match(observabilityAnalyzer, /unexpected_scripts/);
  assert.match(observabilityAnalyzer, /missing_required_scripts/);
  assert.match(observabilityAnalyzer, /return 0 if ok else 1/);
});
