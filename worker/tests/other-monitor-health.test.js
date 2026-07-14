import assert from 'node:assert/strict';
import test from 'node:test';

import { clearRecoveredCloudHostError } from '../src/cloud-host-monitor.js';
import { runOfficialNewsMonitor } from '../src/official-news-probe.js';

test('cloud host recovery clears a stored monitor error when no solo probe is due', async () => {
  const writes = [];
  const state = { id: 'solo:sakurazaka46jp', phase: 'idle', lastError: 'temporary failure' };

  const cleared = await clearRecoveredCloudHostError({}, state, false, async (_env, id, values) => {
    writes.push([id, values]);
  });

  assert.equal(cleared, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], state.id);
  assert.equal(writes[0][1].lastError, null);
});

test('cloud host recovery leaves error clearing to a due solo probe', async () => {
  let writes = 0;
  const cleared = await clearRecoveredCloudHostError(
    {},
    { id: 'solo:sakurazaka46jp', lastError: 'temporary failure' },
    true,
    async () => { writes += 1; },
  );

  assert.equal(cleared, false);
  assert.equal(writes, 0);
});

test('official active-probe failures are persisted for other health', async () => {
  const failure = new Error('Stationhead 401: active probe');
  const writes = [];
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await runOfficialNewsMonitor({ DB: {}, OTHER_DB: {} }, {}, 9_000, {
      checkOfficialNews: async () => {},
      probeAnnouncements: async () => { throw failure; },
      monitorState: async () => ({ last_check_at: 8_000, last_success_at: 7_000 }),
      saveMonitorState: async (_env, values) => { writes.push(values); },
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(writes, [{
    lastCheckAt: 8_000,
    lastSuccessAt: 7_000,
    lastError: failure.message,
  }]);
});
