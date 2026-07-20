import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

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
  'stationhead-buddy-playback',
  'stationhead-host-monitor',
  'stationhead-pages-read-model-publication',
  'stationhead-read-model',
];

test('manual deploy exposes Pages and the three active Workers only', () => {
  assert.match(deployWorkflow, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(deployWorkflow, /^\s{2}push:/m);
  assert.match(deployWorkflow, /wrangler pages deploy/);
  for (const target of ['ingest', 'minute-enrichment', 'runtime']) {
    assert.match(deployWorkflow, new RegExp(`- ${target}`));
  }
  for (const command of [
    'deploy:ingest',
    'deploy:minute-enrichment',
    'deploy:runtime',
  ]) {
    assert.match(deployWorkflow, new RegExp(command));
  }
  assert.doesNotMatch(deployWorkflow, /deploy:split-other|deploy:minute(?!-enrichment)|deploy:other/);
  assert.equal((deployWorkflow.match(/^  [a-z][a-z-]*:\n    name:/gm) || []).length, 2);
});

test('automatic deploys select affected Workers from one import graph', () => {
  for (const workflow of [splitDeployWorkflow, prDiagnosticsWorkflow]) {
    assert.match(workflow, /select-worker-deploys\.mjs/);
    assert.match(workflow, /site\/functions\/\*\*/);
    assert.match(workflow, /packages\/sh-shared\/\*\*/);
    assert.match(workflow, /DEPLOY_COMMANDS/);
    assert.match(workflow, /npm run "\$command"/);
    assert.doesNotMatch(workflow, /sync-cloudflare-build-watch-paths/);
  }

  assert.match(splitDeployWorkflow, /workflow_dispatch/);
  assert.match(splitDeployWorkflow, /select-worker-deploys\.mjs --all/);
  assert.match(prDiagnosticsWorkflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(prDiagnosticsWorkflow, /runtime_changes/);
  assert.doesNotMatch(prDiagnosticsWorkflow, /Reinitialize track-history publication|Probe Pages Queue consumer/);
});

test('all deployment paths provision current Queue boundaries', () => {
  for (const queue of splitQueues) {
    for (const workflow of [deployWorkflow, splitDeployWorkflow, prDiagnosticsWorkflow]) {
      assert.match(workflow, new RegExp(`${queue} ${queue}-dlq`));
    }
  }
});

test('Worker package scripts contain only active deployment and bundle operations', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(workerPackage.scripts).filter(([name]) => name.startsWith('deploy'))),
    {
      deploy: 'node scripts/deploy-connected-worker.mjs',
      'deploy:ingest': 'node scripts/deploy-ingest.mjs',
      'deploy:minute-enrichment': 'node scripts/deploy-minute-enrichment.mjs',
      'deploy:runtime': 'node scripts/deploy-runtime.mjs',
    },
  );
  assert.equal(workerPackage.scripts.postinstall, undefined);
  assert.equal(workerPackage.scripts['check:ingest-bundle'] !== undefined, true);
  assert.equal(workerPackage.scripts['check:minute-enrichment-bundle'] !== undefined, true);
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

test('Cloudflare Git diagnostics target the runtime Worker', () => {
  assert.match(diagnosticsWorkflow, /^\s{2}push:/m);
  assert.match(diagnosticsWorkflow, /branches: \[main\]/);
  assert.match(diagnosticsWorkflow, /sh-runtime-orchestrator/);
  assert.match(diagnosticsWorkflow, /wrangler\\\.runtime\\\.jsonc|wrangler\.runtime\.jsonc/);
  assert.doesNotMatch(diagnosticsWorkflow, /sh-monitor-other/);
  assert.match(diagnosticsWorkflow, /cloudflare-build-diagnostics\.mjs/);
});

test('observability requires active Workers and tolerates retired names during cleanup', () => {
  for (const worker of [
    'sh-buddies-ingest',
    'sh-minute-enrichment',
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
