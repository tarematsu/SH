import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(
  new URL('../.github/workflows/fetch-cloudflare-observability.yml', import.meta.url),
  'utf8',
);
const queryScript = readFileSync(
  new URL('../.github/scripts/query-cloudflare-observability.py', import.meta.url),
  'utf8',
);
const auditScript = readFileSync(
  new URL('../.github/scripts/audit-cloudflare-telemetry.py', import.meta.url),
  'utf8',
);
const deployedAuditUrl = new URL(
  '../.github/scripts/audit-deployed-cloudflare-telemetry.py',
  import.meta.url,
);
const deployedAuditScript = readFileSync(deployedAuditUrl, 'utf8');
const dailyBudgetScript = readFileSync(
  new URL('../.github/scripts/audit-cloudflare-daily-usage.py', import.meta.url),
  'utf8',
);
const d1QueryCostUrl = new URL(
  '../.github/scripts/query-cloudflare-d1-costs.py',
  import.meta.url,
);
const d1QueryCostScript = readFileSync(d1QueryCostUrl, 'utf8');
const liveTailScript = readFileSync(
  new URL('../.github/scripts/capture-cloudflare-live-tail.mjs', import.meta.url),
  'utf8',
);
const wranglerFiles = [
  'wrangler.sakurazaka46jp.jsonc',
  'wrangler.runtime.jsonc',
].map((name) => ({
  name,
  source: readFileSync(new URL(`../worker/${name}`, import.meta.url), 'utf8'),
}));

test('observability uses measured hourly budgets and post-deploy Cloudflare API diagnostics', () => {
  assert.match(workflow, /^  workflow_run:\n/m);
  assert.match(workflow, /workflows: \["Deploy production"\]/);
  assert.match(workflow, /^  schedule:\n/m);
  assert.doesNotMatch(workflow, /^  pull_request:\n/m);
  assert.doesNotMatch(workflow, /^  push:\n/m);
  assert.match(workflow, /CLOUDFLARE_WORKERS: sh-sakurazaka46jp,sh-runtime-orchestrator/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_WORKERS:.*sh-buddies-ingest/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_WORKERS:.*sh-minute-enrichment/);
  assert.match(workflow, /secrets\.CLOUDFLARE_BUILDS_API_TOKEN/);
  assert.match(workflow, /audit-cloudflare-daily-usage\.py/);
  assert.match(workflow, /query-cloudflare-observability\.py/);
  assert.match(workflow, /audit-deployed-cloudflare-telemetry\.py/);
  assert.match(workflow, /LIVE_TAIL_LOG: live-tail\.log/);
  assert.doesNotMatch(workflow, /audit-cloudflare-live-tail\.py/);
  assert.match(workflow, /CPU_BUDGET_MS: "10"/);
  assert.match(workflow, /DURABLE_OBJECT_CPU_BUDGET_MS: "30000"/);
  assert.match(workflow, /DAILY_REQUEST_BUDGET: "70000"/);
  assert.match(workflow, /DAILY_REQUEST_RESERVE: "0"/);
  assert.match(workflow, /DAILY_D1_READ_BUDGET: "3000000"/);
  assert.match(workflow, /DAILY_D1_WRITE_BUDGET: "70000"/);
  assert.match(workflow, /LIVE_TAIL_SECONDS: "90"/);
  assert.doesNotMatch(workflow, /R2_BUCKET|AWS_|aws s3api/);
  assert.match(workflow, /Upload sanitized observability report/);
  assert.match(workflow, /retention-days: 1/);
  assert.doesNotMatch(workflow, /observability-logs\/|raw\/|\.ndjson/);
});

test('query and audit scripts use Cloudflare APIs without R2', () => {
  assert.match(queryScript, /workersInvocationsAdaptive/);
  assert.match(queryScript, /workers\/observability\/telemetry\/query/);
  assert.match(queryScript, /"view": "events"/);
  assert.match(queryScript, /GITHUB_STEP_SUMMARY/);
  assert.match(queryScript, /urlunsplit/);
  assert.match(auditScript, /workers\.get\("cpuTimeMs"\)/);
  assert.match(auditScript, /"view": "events"/);
  assert.match(auditScript, /\$workers\.cpuTimeMs/);
  assert.match(auditScript, /scriptVersion/);
  assert.match(auditScript, /fromisoformat/);
  assert.match(auditScript, /old_version_invocations_excluded/);
  assert.match(auditScript, /LIVE_TAIL_EVENT=/);
  assert.match(auditScript, /_diagnostic_source/);
  assert.match(auditScript, /DURABLE_OBJECT_CPU_BUDGET_MS/);
  assert.match(auditScript, /coverage_ok/);
  assert.match(auditScript, /missing_workers/);
  assert.match(auditScript, /incomplete coverage/);
  assert.match(deployedAuditScript, /workers\/scripts\/\{encoded\}\/deployments/);
  assert.match(deployedAuditScript, /deployments\[0\]/);
  assert.match(deployedAuditScript, /percentage/);
  assert.match(deployedAuditScript, /version_id/);
  assert.match(deployedAuditScript, /deployed_current_events/);
  assert.match(deployedAuditScript, /audit\.current_events/);
  assert.match(deployedAuditScript, /old_late/);
  assert.match(dailyBudgetScript, /workersInvocationsAdaptive/);
  assert.match(dailyBudgetScript, /d1AnalyticsAdaptiveGroups/);
  assert.match(dailyBudgetScript, /rowsRead rowsWritten/);
  assert.match(dailyBudgetScript, /measuredRequests/);
  assert.match(dailyBudgetScript, /requestReserve/);
  assert.doesNotMatch(
    `${queryScript}\n${auditScript}\n${deployedAuditScript}\n${dailyBudgetScript}`,
    /r2\.cloudflarestorage|aws s3|R2_BUCKET/,
  );
});

test('deployment-backed telemetry selector passes its executable self-test', () => {
  const result = spawnSync(
    'python3',
    [fileURLToPath(deployedAuditUrl), '--self-test'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /deployed telemetry audit self-test passed/);
});

test('D1 query cost collector uses GraphQL and passes its privacy self-test', () => {
  assert.match(d1QueryCostScript, /d1QueriesAdaptiveGroups/);
  assert.match(d1QueryCostScript, /sum_rowsRead_DESC/);
  assert.match(d1QueryCostScript, /sum_rowsWritten_DESC/);
  assert.match(d1QueryCostScript, /count_DESC/);
  assert.doesNotMatch(d1QueryCostScript, /wrangler d1 insights/);
  const result = spawnSync('python3', [fileURLToPath(d1QueryCostUrl), '--self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('live-tail diagnostics redact sensitive request fields', () => {
  assert.match(liveTailScript, /telemetry\/live-tail/);
  assert.match(liveTailScript, /scriptId: worker/);
  assert.match(liveTailScript, /\[redacted\]/);
  assert.match(liveTailScript, /parsed\.protocol.*parsed\.host.*parsed\.pathname/s);
  assert.doesNotMatch(liveTailScript, /console\.log\(.*token/);
});

test('all deployed Workers persist invocation logs and disable Logpush export', () => {
  for (const { name, source } of wranglerFiles) {
    assert.match(source, /"observability"\s*:\s*\{/u, name);
    assert.match(source, /"enabled"\s*:\s*true/u, name);
    assert.match(source, /"persist"\s*:\s*true/u, name);
    assert.match(source, /"invocation_logs"\s*:\s*true/u, name);
    assert.doesNotMatch(source, /"logpush"\s*:\s*true/u, name);
  }
});
