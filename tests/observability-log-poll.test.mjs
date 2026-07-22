import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const fetcher = readFileSync(
  new URL('../.github/scripts/fetch-r2-worker-logs.py', import.meta.url),
  'utf8',
);

test('R2 log polling relies on analyzer-required scripts rather than every active Worker', () => {
  assert.match(fetcher, /summary\.get\("missing_required_scripts"\)/);
  assert.match(fetcher, /summary\.get\("cpu_ms"\)/);
  assert.match(fetcher, /events > 0 and samples > 0 and not missing/);
  assert.doesNotMatch(fetcher, /REQUIRED_ACTIVE_WORKERS/);
  assert.doesNotMatch(fetcher, /sh-sakurazaka46jp,sh-runtime-orchestrator/);
});
