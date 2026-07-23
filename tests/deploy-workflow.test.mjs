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
const factsVerification = readFileSync(
  new URL('../worker/scripts/verify-facts-live.mjs', import.meta.url),
  'utf8',
);
const observabilityWorkflow = readFileSync(
  new URL('../.github/workflows/fetch-cloudflare-observability.yml', import.meta.url),
  'utf8',
);
const observabilityQuery = readFileSync(
  new URL('../.github/scripts/query-cloudflare-observability.py', import.meta.url),
  'utf8',
);
const cpuPolicy = readFileSync(
  new URL('../.github/scripts/enforce-worker-cpu-budget.py', import.meta.url),
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

const retiredCoreDeployFiles = [
  '../worker/wrangler.ingest.jsonc',
  '../worker/wrangler.minute-enrichment.jsonc',
  '../worker/scripts/deploy-ingest.mjs',
  '../worker/scripts/deploy-minute-enrichment.mjs',
];

function jobSection(source, name, nextName) {
  const start = source.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `${name} job must exist`);
  const end = nextName ? source.indexOf(`  ${nextName}:\n`, start + 1) : source.length;
  assert.notEqual(end, -1, `${nextName} job must exist after ${name}`);
  return source.slice(start, end);
}

test('one GitHub Actions workflow owns automatic and manual production deployments', () => {
  assert.match(deploymentWorkflow, /^name: Deploy production$/m);
  assert.match(deploymentWorkflow, /^  push:$/m);
  assert.match(deploymentWorkflow, /branches: \[main\]/);
  assert.match(deploymentWorkflow, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(deploymentWorkflow, /^  pull_request:$/m);
  assert.match(deploymentWorkflow, /group: deploy-production-minute-db-v2/);

  for (const target of ['pages', 'workers', 'sakurazaka46jp', 'runtime']) {
    assert.match(deploymentWorkflow, new RegExp(`- ${target}`));
  }
  assert.doesNotMatch(deploymentWorkflow, /- ingest$/m);
  assert.doesNotMatch(deploymentWorkflow, /- minute-enrichment$/m);
  for (const command of ['deploy:sakurazaka46jp', 'deploy:runtime']) {
    assert.match(deploymentWorkflow, new RegExp(command));
  }
  assert.doesNotMatch(deploymentWorkflow, /deploy:ingest/);
  assert.doesNotMatch(deploymentWorkflow, /deploy:minute-enrichment/);

  assert.match(deploymentWorkflow, /name: Apply MINUTE_DB migrations before deployment/);
  assert.match(deploymentWorkflow, /name: Deploy affected Workers/);
  assert.match(deploymentWorkflow, /name: Build and deploy Pages/);
  assert.match(deploymentWorkflow, /wrangler pages deploy public --project-name skrzk --branch main/);
  assert.match(deploymentWorkflow, /needs: \[select, minute_db\]/);
  assert.match(deploymentWorkflow, /needs: \[select, minute_db, workers\]/);
  assert.match(
    deploymentWorkflow,
    /needs\.minute_db\.result == 'success' \|\| needs\.minute_db\.result == 'skipped'/,
  );
  assert.match(deploymentWorkflow, /needs\.workers\.result == 'success' \|\| needs\.workers\.result == 'skipped'/);
});

test('Pages-bound legacy Worker is retired after every successful binding cutover', () => {
  const pagesDeploy = deploymentWorkflow.indexOf('name: Deploy Pages from GitHub Actions');
  const retirement = deploymentWorkflow.indexOf('name: Retire legacy Pages-bound Worker after binding cutover');
  assert.ok(pagesDeploy >= 0);
  assert.ok(retirement > pagesDeploy);
  const retirementStep = deploymentWorkflow.slice(retirement);
  assert.doesNotMatch(retirementStep.split('run: >-')[0], /^\s+if:/m);
  assert.match(retirementStep, /pruneRetiredWorkers\(\['sh-minute-enrichment'\]\)/);
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

test('MINUTE_DB migrations are a blocking reusable stage before Worker and Pages deployment', () => {
  assert.match(deploymentWorkflow, /database\/facts-db\.json/);
  assert.match(deploymentWorkflow, /database\/facts-migrations\/\*\*/);
  assert.match(deploymentWorkflow, /\.github\/workflows\/database\.yml/);
  assert.match(deploymentWorkflow, /echo "minute_db=\$minute_db" >> "\$GITHUB_OUTPUT"/);

  const minuteDb = jobSection(deploymentWorkflow, 'minute_db', 'workers');
  assert.match(minuteDb, /uses: \.\/\.github\/workflows\/database\.yml/);
  assert.match(minuteDb, /operation: minute-db/);
  assert.match(minuteDb, /base_sha: \$\{\{ github\.event\.before \|\| '' \}\}/);
  assert.match(minuteDb, /head_sha: \$\{\{ github\.sha \}\}/);
  assert.match(minuteDb, /secrets: inherit/);

  const workers = jobSection(deploymentWorkflow, 'workers', 'pages');
  assert.match(workers, /needs: \[select, minute_db\]/);
  assert.match(workers, /needs\.minute_db\.result == 'success'/);
  assert.match(workers, /needs\.minute_db\.result == 'skipped'/);

  const pages = jobSection(deploymentWorkflow, 'pages');
  assert.match(pages, /needs: \[select, minute_db, workers\]/);
  assert.match(pages, /needs\.minute_db\.result == 'success'/);
  assert.match(pages, /needs\.minute_db\.result == 'skipped'/);

  assert.match(databaseWorkflow, /^  workflow_call:$/m);
  assert.match(databaseWorkflow, /^      base_sha:$/m);
  assert.match(databaseWorkflow, /^      head_sha:$/m);
  assert.match(databaseWorkflow, /group: sh-database-operations-v2-/);
  assert.doesNotMatch(databaseWorkflow, /database\/facts-migrations\/\*\*/);
  assert.doesNotMatch(databaseWorkflow, /- '\.github\/workflows\/database\.yml'/);
  const databaseMinute = jobSection(databaseWorkflow, 'minute-db', 'payload-purge');
  assert.match(databaseMinute, /if: inputs\.operation == 'minute-db'/);
  assert.doesNotMatch(databaseMinute, /github\.event_name == 'push'/);
  assert.match(databaseMinute, /name: Apply MINUTE_DB schema/);
  assert.match(databaseMinute, /FACTS_DEPLOY_CHANGED_ONLY: 'true'/);
  assert.match(databaseMinute, /DEPLOY_BASE_SHA:/);
  assert.match(databaseMinute, /DEPLOY_HEAD_SHA:/);
  assert.match(databaseMinute, /fetch-depth: 0/);
  assert.match(databaseMinute, /name: Apply changed MINUTE_DB migrations/);
  assert.match(databaseMinute, /node scripts\/apply-facts-pr-schema\.mjs/);
  assert.match(databaseMinute, /name: Verify live data and deployment-critical schema/);
  assert.match(databaseMinute, /node scripts\/verify-facts-live\.mjs/);
  assert.doesNotMatch(databaseMinute, /provision-current-facts-db/);
  assert.doesNotMatch(databaseMinute, /purge-completed-minute-fact-payloads/);
  assert.doesNotMatch(databaseMinute, /repair-july-stream-facts/);

  assert.match(factsVerification, /dashboard_history_5m_present/);
  assert.match(factsVerification, /minute_fact_inbox_stats_present/);
  assert.match(factsVerification, /minute_fact_inbox_stats_triggers_present/);
  assert.match(factsVerification, /sh_dashboard_history_5m/);
  assert.match(factsVerification, /sh_minute_fact_inbox_stats/);
});

test('Cloudflare Git build and PR production deployment files remain deleted', () => {
  for (const path of removedCloudflareGitFiles) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} must remain deleted`);
  }
  assert.match(databaseWorkflow, /name: Verify live data and deployment-critical schema/);
  assert.match(databaseWorkflow, /node scripts\/verify-facts-live\.mjs/);
});

test('the production Worker deployment provisions current Queue boundaries', () => {
  for (const queue of splitQueues) {
    assert.match(deploymentWorkflow, new RegExp(`${queue} ${queue}-dlq`));
  }
});

test('Worker package scripts contain only the two active deployment and bundle operations', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(workerPackage.scripts).filter(([name]) => name.startsWith('deploy'))),
    {
      deploy: 'node scripts/deploy-connected-worker.mjs',
      'deploy:sakurazaka46jp': 'node scripts/deploy-sakurazaka46jp.mjs',
      'deploy:runtime': 'node scripts/deploy-runtime.mjs',
    },
  );
  assert.equal(workerPackage.scripts.postinstall, undefined);
  assert.equal(workerPackage.scripts['check:ingest-bundle'], undefined);
  assert.equal(workerPackage.scripts['check:minute-enrichment-bundle'], undefined);
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
    ...retiredCoreDeployFiles,
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} must remain deleted`);
  }
});

test('observability covers the two active Workers through Cloudflare APIs without R2', () => {
  for (const worker of ['sh-sakurazaka46jp', 'sh-runtime-orchestrator']) {
    assert.match(observabilityWorkflow, new RegExp(worker));
    assert.match(cpuPolicy, new RegExp(worker));
  }
  for (const retired of [
    'sh-buddies-ingest',
    'sh-minute-enrichment',
    'sh-monitor-other',
    'sh-pages-read-model',
    'sh-minute-derive',
    'sh-host-monitor',
  ]) {
    assert.doesNotMatch(observabilityWorkflow, new RegExp(retired));
    assert.doesNotMatch(cpuPolicy, new RegExp(`"${retired}"`));
  }
  assert.match(observabilityQuery, /workersInvocationsAdaptive/);
  assert.match(observabilityQuery, /workers\/observability\/telemetry\/query/);
  assert.match(observabilityQuery, /cpuTimeP99/);
  assert.match(cpuPolicy, /BUDGET_MS = 10\.0/);
  assert.doesNotMatch(`${observabilityWorkflow}\n${observabilityQuery}\n${cpuPolicy}`, /R2_BUCKET|r2\.cloudflarestorage|aws s3api/);
});
