import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRunFullDiagnostics } from '../src/cadenced-entry.js';

test('full diagnostics run once per five-minute bucket', () => {
  const env = { DIAGNOSTIC_INTERVAL_MINUTES: 5 };
  assert.equal(shouldRunFullDiagnostics(0, env), true);
  assert.equal(shouldRunFullDiagnostics(4 * 60_000, env), false);
  assert.equal(shouldRunFullDiagnostics(5 * 60_000, env), true);
});
