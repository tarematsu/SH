import assert from 'node:assert/strict';
import test from 'node:test';

import { validDate } from '../src/email-recap-utils.js';

test('email recap date validation rejects calendar rollover dates', () => {
  assert.equal(validDate('2026-02-28'), true);
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2026-13-01'), false);
});
