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
const wranglerFiles = [
  'wrangler.ingest.jsonc',
  'wrangler.minute-enrichment.jsonc',
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
  assert.match(workflow, /CLOUDFLARE_WORKERS: sh-buddies-ingest,sh-minute-enrichment,sh-sakurazaka46jp,sh-runtime-orchestrator/);
  assert.match(workflow, /secrets\.CLOUDFLARE_BUILDS_API_TOKEN/);
  assert.match(workflow, /query-cloudflare-observability\.py/);
  assert.doesNotMatch(workflow, /R2_BUCKET|AWS_|aws s3api|upload-artifact/);
});

test('query script reads metrics and sanitized error samples without R2', () => {
  assert.match(queryScript, /workersInvocationsAdaptive/);
  assert.match(queryScript, /workers\/observability\/telemetry\/query/);
  assert.match(queryScript, /GITHUB_STEP_SUMMARY/);
  assert.match(queryScript, /urlunsplit/);
  assert.doesNotMatch(queryScript, /r2\.cloudflarestorage|aws s3|R2_BUCKET/);
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
