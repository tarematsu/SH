import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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

test('observability workflow uses Cloudflare APIs on PRs and main pushes', () => {
  assert.match(workflow, /^  pull_request:\n/m);
  assert.match(workflow, /^  push:\n/m);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /CLOUDFLARE_WORKERS: sh-sakurazaka46jp,sh-runtime-orchestrator/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_WORKERS:.*sh-buddies-ingest/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_WORKERS:.*sh-minute-enrichment/);
  assert.match(workflow, /secrets\.CLOUDFLARE_BUILDS_API_TOKEN/);
  assert.match(workflow, /query-cloudflare-observability\.py/);
  assert.match(workflow, /audit-cloudflare-telemetry\.py/);
  assert.match(workflow, /CPU_BUDGET_MS: "10"/);
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
  assert.match(auditScript, /scriptVersion/);
  assert.match(auditScript, /old_version_invocations_excluded/);
  assert.match(auditScript, /CPU_BUDGET_MS/);
  assert.match(auditScript, /coverage_ok/);
  assert.match(auditScript, /incomplete coverage/);
  assert.doesNotMatch(`${queryScript}\n${auditScript}`, /r2\.cloudflarestorage|aws s3|R2_BUCKET/);
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
