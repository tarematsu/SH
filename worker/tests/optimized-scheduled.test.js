import assert from 'node:assert/strict';
import test from 'node:test';

import { runOptimizedScheduled } from '../src/optimized-index.js';

const AUTH_STATE = { authToken: 'token', deviceUid: 'device' };

test('optimized scheduled collection propagates collector failures', async () => {
  const failure = new Error('collector failed');
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await assert.rejects(runOptimizedScheduled({}, {}, {}, {
      ensureSession: async () => AUTH_STATE,
      collectorScheduled: async () => { throw failure; },
    }), failure);
  } finally {
    console.error = originalConsoleError;
  }
});

test('optimized scheduled collection refreshes authentication once after a 401', async () => {
  const calls = [];
  const refreshed = { authToken: 'new-token', deviceUid: 'new-device' };

  await runOptimizedScheduled({}, {}, {}, {
    ensureSession: async () => AUTH_STATE,
    refreshSession: async (_env, reason, force) => {
      calls.push(['refresh', reason, force]);
      return refreshed;
    },
    collectorScheduled: async (_controller, env) => {
      calls.push(['collector', env.__shAuthState.authToken, env.__shAuthState.deviceUid]);
      if (calls.filter(([name]) => name === 'collector').length === 1) throw new Error('401 session expired');
    },
  });

  assert.deepEqual(calls, [
    ['collector', 'token', 'device'],
    ['refresh', 'api-401', true],
    ['collector', 'new-token', 'new-device'],
  ]);
});
