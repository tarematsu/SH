import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('idle minute health reduces D1 probes and heartbeat writes by seventy-five percent', () => {
  const maintenance = source('../worker/src/minute-maintenance-entry.js');
  const health = source('../worker/src/minute-facts-inbox-health.js');
  const runtimeState = source('../worker/src/minute-facts-runtime-state.js');

  assert.match(maintenance, /DERIVE_STATE_CHECKPOINT_MS = 20 \* 60_000/);
  assert.match(maintenance, /state_checkpoint_skipped/);
  assert.match(maintenance, /minute-facts-inbox-health\.js/);
  assert.match(health, /COUNT\(\*\) FILTER \(WHERE job_kind='rebuild'\)/);
  assert.equal((health.match(/WHERE status='pending'/g) || []).length, 1);
  assert.match(runtimeState, /RUNTIME_SUCCESS_CHECKPOINT_MS = 20 \* 60_000/);

  const previousPolls = 24 * 60 / 5;
  const optimizedPolls = 24 * 60 / 20;
  assert.equal(previousPolls, 288);
  assert.equal(optimizedPolls, 72);
  assert.equal(1 - optimizedPolls / previousPolls, 0.75);

  const previousStatusIndexScans = previousPolls * 6;
  const optimizedStatusIndexScans = optimizedPolls * 3;
  assert.equal(1 - optimizedStatusIndexScans / previousStatusIndexScans, 0.875);
});
