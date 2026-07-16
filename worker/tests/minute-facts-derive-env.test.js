import assert from 'node:assert/strict';
import test from 'node:test';

import { runMinuteFactDeriveCron } from '../src/minute-facts-derive.js';

function job() {
  return {
    id: 1,
    attempts: 1,
    payload_version: 1,
    payload_json: JSON.stringify({
      payload_version: 1,
      observedAt: 120_001,
      snapshot: { channel_id: 10 },
      queue: null,
      comments: {},
    }),
  };
}

test('derive cron preserves non-configurable Cloudflare bindings while overriding timeout', async () => {
  const minuteDb = {};
  const env = {};
  Object.defineProperty(env, 'MINUTE_DB', {
    value: minuteDb,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  let receivedEnv;
  const result = await runMinuteFactDeriveCron(env, {
    now: () => 1_000,
    claim: async () => [job()],
    write: async (activeEnv) => {
      receivedEnv = activeEnv;
      assert.equal(activeEnv.MINUTE_DB, minuteDb);
      assert.equal(activeEnv.MINUTE_FACT_TIMEOUT_MS, 18_000);
    },
    complete: async () => {},
    fail: async () => { throw new Error('unexpected fail'); },
    release: async () => {},
    stats: async () => ({ pending_count: 0, processing_count: 0, dead_count: 0 }),
  });

  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.notEqual(receivedEnv, env);
  assert.equal(Object.getPrototypeOf(receivedEnv), env);
});
