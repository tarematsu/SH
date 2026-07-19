import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const analyzer = readFileSync(
  new URL('../../.github/scripts/analyze-worker-observability.py', import.meta.url),
  'utf8',
);
const incrementalWorkflow = readFileSync(
  new URL('../../.github/workflows/fetch-cloudflare-observability.yml', import.meta.url),
  'utf8',
);
const hourlyWorkflow = readFileSync(
  new URL('../../.github/workflows/fetch-cloudflare-observability-hourly.yml', import.meta.url),
  'utf8',
);

test('pre-cutover Worker names are allowed without hiding their failures', () => {
  assert.match(analyzer, /tracked_scripts = EXPECTED_SCRIPTS \| transition_scripts/);
  assert.doesNotMatch(analyzer, /if script in transition_scripts:\s*\n\s*continue/);
  assert.match(analyzer, /error_events = sum\(errors\.values\(\)\)/);
  assert.match(analyzer, /"transitional": script in transition_scripts/);
});

test('pre-cutover audits require the retired every-minute collector to remain healthy', () => {
  assert.match(analyzer, /TRANSITION_SCHEDULES/);
  assert.match(analyzer, /"sh-buddies-monitor": lambda minute: True/);
  assert.match(analyzer, /required_schedules\[script\] = predicate/);
});

test('topology renames use real lookback windows instead of a skipped deployment timestamp', () => {
  for (const workflow of [incrementalWorkflow, hourlyWorkflow]) {
    assert.match(workflow, /Topology rename has no direct PR deployment/);
    assert.match(workflow, /git diff --diff-filter=M -U0/);
    assert.match(workflow, /grep -Eq '\^\[\+-\]/);
  }
});
