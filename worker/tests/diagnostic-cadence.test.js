import assert from 'node:assert/strict';
import test from 'node:test';

import {
  markDiagnosticFailure,
  resetDiagnosticFailureWindow,
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
