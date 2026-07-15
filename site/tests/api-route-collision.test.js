import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

test('Pages health file and directory do not define the same route', () => {
  assert.equal(existsSync(new URL('../functions/api/health.js', import.meta.url)), true);
  assert.equal(existsSync(new URL('../functions/api/health/index.js', import.meta.url)), false);
});
