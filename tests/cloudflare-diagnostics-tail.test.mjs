import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/cloudflare-pr-diagnostics.yml', import.meta.url),
  'utf8',
);
const observability = readFileSync(
  new URL('../.github/workflows/fetch-cloudflare-observability.yml', import.meta.url),
  'utf8',
);
const observabilityAnalyzer = readFileSync(
  new URL('../.github/scripts/analyze-worker-observability.py', import.meta.url),
  'utf8',
);

test('direct PR deploys do not launch a second Cloudflare build watcher', () => {
  assert.match(workflow, /always\(\)/);
  assert.match(workflow, /needs\.select-workers\.outputs\.topology_rename == 'true'/);
  assert.match(workflow, /needs\.select-workers\.outputs\.diagnostics != '\[\]'/);
  assert.doesNotMatch(workflow, /needs\.prepare-workers\.result == 'success'/);
  assert.doesNotMatch(workflow, /direct PR deploy already succeeded/);
});

test('topology renames keep strict external build verification', () => {
  assert.match(workflow, /Skipping direct PR deploy because a Worker script name changed/);
  assert.match(workflow, /run: node \.github\/scripts\/cloudflare-build-diagnostics\.mjs/);
  assert.doesNotMatch(workflow, /status=\$\?/);
  assert.doesNotMatch(workflow, /exit 0/);
});

test('observability extraction uses the dedicated strict analyzer', () => {
  assert.match(observability, /python3 \.github\/scripts\/analyze-worker-observability\.py/);
  assert.match(observabilityAnalyzer, /for event in iter_events\(raw_dir\):/);
  assert.match(observabilityAnalyzer, /event_failure\(event\)/);
  assert.match(observabilityAnalyzer, /event\.get\("CPUTimeMs"\)/);
  assert.match(observabilityAnalyzer, /return 0 if ok else 1/);
  assert.doesNotMatch(observability, /def event_metrics\(event\):/);
});
