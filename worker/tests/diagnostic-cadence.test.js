import assert from 'node:assert/strict';
import test from 'node:test';

import {
  markDiagnosticFailure,
  resetDiagnosticFailureWindow,
  scheduleBuddyPlayback,
  scheduledTimestamp,
  shouldRunFullDiagnostics,
} from '../src/cadenced-entry.js';

test('full diagnostics run once per ten-minute bucket by default', () => {
  resetDiagnosticFailureWindow();
  assert.equal(shouldRunFullDiagnostics(0, {}), true);
  assert.equal(shouldRunFullDiagnostics(9 * 60_000, {}), false);
  assert.equal(shouldRunFullDiagnostics(10 * 60_000, {}), true);
});

test('failures temporarily enable per-minute diagnostics', () => {
  resetDiagnosticFailureWindow();
  markDiagnosticFailure(60_000);
  assert.equal(shouldRunFullDiagnostics(2 * 60_000, {}), true);
  resetDiagnosticFailureWindow();
});

test('scheduled timestamp uses the cron slot instead of delayed wall-clock time', () => {
  assert.equal(scheduledTimestamp({ scheduledTime: 300_000 }, 360_000), 300_000);
  assert.equal(scheduledTimestamp({}, 360_000), 360_000);
});

test('buddy playback receives the scheduled cron timestamp and is attached to waitUntil', async () => {
  let receivedAt = null;
  let pending = null;
  const result = scheduleBuddyPlayback(
    { DB: {} },
    { waitUntil(value) { pending = value; } },
    300_000,
    async (_env, now) => {
      receivedAt = now;
      return { skipped: false };
    },
  );

  assert.equal(result, pending);
  assert.deepEqual(await result, { skipped: false });
  assert.equal(receivedAt, 300_000);
});
