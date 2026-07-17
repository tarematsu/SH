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
const observabilityWorkflow = readFileSync(
  new URL('../.github/workflows/fetch-cloudflare-observability.yml', import.meta.url),
  'utf8',
);
const workerPackage = JSON.parse(readFileSync(
  new URL('../worker/package.json', import.meta.url),
  'utf8',
));

const selectorName = 'select-worker-deploys.mjs';
const splitQueues = [
  'stationhead-buddies-persist',
  'stationhead-track-metadata',
  'stationhead-minute-enrichment',
  'stationhead-minute-rebuild',
  'stationhead-buddy-playback',
];

test('manual deploy keeps all Cloudflare targets available', () => {
  const fallback = 'secrets.CLOUDFLARE_BUILDS_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN || secrets.CF_API_TOKEN';
  const occurrences = deployWorkflow.split(fallback).length - 1;

  assert.match(deployWorkflow, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(deployWorkflow, /^\s{2}push:/m);
  assert.match(deployWorkflow, /wrangler pages deploy/);
  assert.match(deployWorkflow, /npm run deploy:buddies/);
  assert.match(deployWorkflow, /npm run deploy:persist/);
  assert.match(deployWorkflow, /npm run deploy:ingest/);
  assert.match(deployWorkflow, /npm run deploy:comments/);
  assert.match(deployWorkflow, /npm run deploy:minute/);
  assert.match(deployWorkflow, /npm run deploy:split-other/);
  assert.equal(occurrences, 3);
});

test('automatic deploys select only affected current Workers and isolate script renames', () => {
  for (const workflow of [splitDeployWorkflow, prDiagnosticsWorkflow]) {
    assert.match(workflow, new RegExp(selectorName.replace('.', '\\.')));
    assert.match(workflow, /site\/functions\/\*\*/);
    assert.match(workflow, /packages\/sh-shared\/\*\*/);
    assert.match(workflow, /DEPLOY_COMMANDS/);
    assert.match(workflow, /npm run "\$command"/);
    assert.doesNotMatch(workflow, /sync-cloudflare-build-watch-paths/);
  }

  assert.match(splitDeployWorkflow, /workflow_dispatch/);
  assert.match(splitDeployWorkflow, /select-worker-deploys\.mjs --all/);
  assert.doesNotMatch(splitDeployWorkflow, /legacy/i);
  assert.doesNotMatch(splitDeployWorkflow, /retire:/);

  assert.match(prDiagnosticsWorkflow, /github\.event\.pull_request\.base\.sha/);
  assert.match(prDiagnosticsWorkflow, /topology_rename/);
  assert.match(prDiagnosticsWorkflow, /git diff --diff-filter=M -U0/);
  assert.match(prDiagnosticsWorkflow, /Skipping direct PR deploy because a Worker script name changed/);
  assert.match(prDiagnosticsWorkflow, /needs\.select-workers\.outputs\.topology_rename != 'true'/);
  assert.match(prDiagnosticsWorkflow, /fromJSON\(needs\.select-workers\.outputs\.diagnostics\)/);
});

test('all deployment paths provision the split Queue boundaries', () => {
  for (const queue of splitQueues) {
    for (const workflow of [deployWorkflow, splitDeployWorkflow, prDiagnosticsWorkflow]) {
      assert.match(workflow, new RegExp(`${queue} ${queue}-dlq`));
    }
  }
});

test('Worker package scripts contain only current deployment operations', () => {
  assert.equal(
    workerPackage.scripts['deploy:minute'],
    'npm run deploy:minute-derive && npm run deploy:minute-enrichment && npm run deploy:minute-rebuild && npm run deploy:minute-maintenance && npm run deploy:minute-ingest && npm run deploy:minute-read-model && npm run deploy:track-metadata',
  );
  assert.equal(
    workerPackage.scripts['deploy:split-other'],
    'npm run deploy:pages-read-model && npm run deploy:monitor-maintenance && npm run deploy:other && npm run deploy:buddy-playback',
  );
  assert.equal(workerPackage.scripts['deploy:persist'], 'wrangler deploy --config wrangler.persist.jsonc');

  for (const key of Object.keys(workerPackage.scripts)) {
    assert.doesNotMatch(key, /detach|retire|cutover|mintue/);
  }
  assert.equal(workerPackage.scripts['deploy:read-model'], undefined);
  assert.equal(workerPackage.scripts['check:read-model-bundle'], undefined);
});

test('Cloudflare Git diagnostics include only remaining connected Worker dependencies', () => {
  assert.match(diagnosticsWorkflow, /^\s{2}push:/m);
  assert.match(diagnosticsWorkflow, /branches: \[main\]/);
  assert.match(diagnosticsWorkflow, /packages\/sh-shared/);
  assert.doesNotMatch(diagnosticsWorkflow, /sh-buddies-monitor/);
  assert.match(diagnosticsWorkflow, /sh-monitor-other/);
  assert.match(diagnosticsWorkflow, /sh-minute-maintenance/);
  assert.match(diagnosticsWorkflow, /cloudflare-build-diagnostics\.mjs/);
});

test('R2 observability covers the complete requested object window and split Workers', () => {
  assert.doesNotMatch(observabilityWorkflow, /selected\s*=\s*selected\[:100\]/);
  assert.match(observabilityWorkflow, /objects_selected/);
  assert.match(observabilityWorkflow, /oldest_object_modified/);
  assert.match(observabilityWorkflow, /newest_object_modified/);
  assert.match(observabilityWorkflow, /Downloaded \$downloaded_count of \$selected_count selected R2 objects/);
  for (const worker of [
    'sh-buddies-persist',
    'sh-track-metadata',
    'sh-minute-enrichment',
    'sh-minute-rebuild',
    'sh-buddy-playback',
  ]) {
    assert.match(observabilityWorkflow, new RegExp(worker));
  }
});
