import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const fetcher = readFileSync(
  new URL('../.github/scripts/fetch-r2-worker-logs.py', import.meta.url),
  'utf8',
);
const incrementalWorkflow = readFileSync(
  new URL('../.github/workflows/fetch-cloudflare-observability.yml', import.meta.url),
  'utf8',
);
const hourlyWorkflow = readFileSync(
  new URL('../.github/workflows/fetch-cloudflare-observability-hourly.yml', import.meta.url),
  'utf8',
);

test('R2 log polling relies on analyzer-required scripts rather than every active Worker', () => {
  assert.match(fetcher, /summary\.get\("missing_required_scripts"\)/);
  assert.match(fetcher, /summary\.get\("cpu_ms"\)/);
  assert.match(fetcher, /events > 0 and samples > 0 and not missing/);
  assert.doesNotMatch(fetcher, /REQUIRED_ACTIVE_WORKERS/);
  assert.doesNotMatch(fetcher, /sh-sakurazaka46jp,sh-runtime-orchestrator/);
});

test('tooling-only observability PRs exclude stale Worker versions', () => {
  for (const workflow of [incrementalWorkflow, hourlyWorkflow]) {
    assert.match(workflow, /date -u -d '10 minutes ago'/);
    assert.match(workflow, /No runtime changes in this PR; auditing the current deployment/);
    assert.match(workflow, /echo "LOG_SINCE=\$audit_since" >> "\$GITHUB_ENV"/);
    assert.doesNotMatch(workflow, /No runtime changes in this PR; using the (?:configured|rolling-hour) lookback/);
  }
});
