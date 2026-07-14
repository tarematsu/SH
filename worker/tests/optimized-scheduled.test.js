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
    refreshSession: async (_env, reason) => {
      calls.push(['refresh', reason]);
      return refreshed;
    },
    collectorScheduled: async (_controller, env) => {
      calls.push(['collector', env.__shAuthState.authToken, env.__shAuthState.deviceUid]);
      if (calls.filter(([name]) => name === 'collector').length === 1) throw new Error('401 session expired');
    },
  });

  assert.deepEqual(calls, [
    ['collector', 'token', 'device'],
    ['refresh', 'api-auth-failure'],
    ['collector', 'new-token', 'new-device'],
  ]);
});

test('optimized scheduled collection also refreshes authentication after a 403', async () => {
  let collectorCalls = 0;
  let refreshCalls = 0;

  await runOptimizedScheduled({}, {}, {}, {
    ensureSession: async () => AUTH_STATE,
    refreshSession: async () => {
      refreshCalls += 1;
      return { authToken: 'new-token', deviceUid: 'new-device' };
    },
    collectorScheduled: async () => {
      collectorCalls += 1;
      if (collectorCalls === 1) throw new Error('Stationhead API 403');
    },
  });

  assert.equal(refreshCalls, 1);
  assert.equal(collectorCalls, 2);
});

test('optimized scheduled collection does not retry when auth refresh is in backoff', async () => {
  const failure = new Error('401 session expired');
  let collectorCalls = 0;

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(runOptimizedScheduled({}, {}, {}, {
      ensureSession: async () => AUTH_STATE,
      refreshSession: async () => null,
      collectorScheduled: async () => {
        collectorCalls += 1;
        throw failure;
      },
    }), failure);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(collectorCalls, 1);
});
