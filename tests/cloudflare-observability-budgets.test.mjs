import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);

function runSelfTest(path) {
  const result = spawnSync('python3', [path, '--self-test'], {
    cwd: rootPath,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${path} self-test failed:\n${result.stdout}\n${result.stderr}`);
}

test('observability policy scripts pass offline self-tests', () => {
  runSelfTest('.github/scripts/audit-cloudflare-daily-usage.py');
  runSelfTest('.github/scripts/audit-cloudflare-free-tier.py');
  runSelfTest('.github/scripts/audit-observability-budget-gates.py');
  runSelfTest('.github/scripts/audit-cloudflare-telemetry.py');
  runSelfTest('.github/scripts/audit-deployed-cloudflare-telemetry.py');
});

test('observability uses post-deploy and daily complete budget checks', async () => {
  const workflow = await readFile(new URL('.github/workflows/fetch-cloudflare-observability.yml', root), 'utf8');
  assert.match(workflow, /workflows: \["Deploy production"\]/);
  assert.doesNotMatch(workflow, /cron: "37 \* \* \* \*"/);
  assert.match(workflow, /cron: "11 3 \* \* \*"/);
  assert.equal((workflow.match(/- cron:/g) || []).length, 1);
  assert.doesNotMatch(workflow, /^\s+pull_request:/m);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /DAILY_REQUEST_BUDGET: "70000"/);
  assert.match(workflow, /DAILY_REQUEST_RESERVE: "0"/);
  assert.match(workflow, /DAILY_D1_READ_BUDGET: "3000000"/);
  assert.match(workflow, /DAILY_D1_WRITE_BUDGET: "70000"/);
  assert.match(workflow, /CLOUDFLARE_RUNTIME_WORKER: sh-runtime-orchestrator/);
  assert.match(workflow, /CLOUDFLARE_KV_BINDINGS: PAGES_RESPONSE_KV/);
  assert.match(workflow, /audit-cloudflare-free-tier\.py --self-test/);
  assert.match(workflow, /audit-observability-budget-gates\.py --self-test/);
  assert.match(workflow, /audit-deployed-cloudflare-telemetry\.py --self-test/);
  assert.match(workflow, /id: free-tier-budget/);
  assert.match(workflow, /id: budget-contract/);
  assert.match(workflow, /id: observability-query/);
  assert.match(workflow, /id: telemetry-policy/);
  assert.match(workflow, /steps\.free-tier-budget\.outcome == 'failure'/);
  assert.match(workflow, /steps\.budget-contract\.outcome == 'failure'/);
  assert.match(workflow, /steps\.observability-query\.outcome == 'failure'/);
  assert.match(workflow, /steps\.telemetry-policy\.outcome == 'failure'/);
  assert.match(workflow, /LIVE_TAIL_SECONDS: "90"/);
  assert.match(workflow, /LIVE_TAIL_LOG: live-tail\.log/);
  assert.match(workflow, /audit-cloudflare-telemetry\.py --self-test/);
  assert.doesNotMatch(workflow, /audit-cloudflare-live-tail\.py/);
  assert.match(workflow, /id: daily-budget/);
  assert.equal((workflow.match(/continue-on-error: true/g) || []).length, 5);
  assert.match(workflow, /steps\.daily-budget\.outcome == 'failure'/);
  assert.match(workflow, /Fail after collecting diagnostics when any observability gate fails/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /observability-gate\//);
  assert.match(workflow, /observability-budget-gate\.log/);
});

test('D1 query insights are manual-only and duplicate budget paths are gone', async () => {
  const workflow = await readFile(new URL('.github/workflows/fetch-cloudflare-d1-usage.yml', root), 'utf8');
  assert.match(workflow, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+pull_request:/m);
  assert.doesNotMatch(workflow, /^\s+schedule:/m);
  await assert.rejects(access(new URL('.github/workflows/cloudflare-worker-request-budget.yml', root)));
  await assert.rejects(access(new URL('scripts/cloudflare-worker-request-budget.mjs', root)));
  await assert.rejects(access(new URL('.github/scripts/audit-cloudflare-live-tail.py', root)));
});
