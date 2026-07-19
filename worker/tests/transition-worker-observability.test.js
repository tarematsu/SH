import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const analyzer = readFileSync(
  new URL('../../.github/scripts/analyze-worker-observability.py', import.meta.url),
  'utf8',
);

test('pre-cutover Worker names are allowed without hiding their failures', () => {
  assert.match(analyzer, /tracked_scripts = EXPECTED_SCRIPTS \| transition_scripts/);
  assert.doesNotMatch(analyzer, /if script in transition_scripts:\s*\n\s*continue/);
  assert.match(analyzer, /error_events = sum\(errors\.values\(\)\)/);
  assert.match(analyzer, /"transitional": script in transition_scripts/);
});
