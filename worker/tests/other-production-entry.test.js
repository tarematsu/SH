import test from 'node:test';
import assert from 'node:assert/strict';

import { pagesRefreshDue } from '../src/other-production-entry.js';

function controllerAt(iso) {
  return { scheduledTime: Date.parse(iso), cron: '*/5 * * * *' };
}

test('pages refresh is due every ten minutes', () => {
  assert.equal(pagesRefreshDue(controllerAt('2026-07-16T11:20:00Z')), true);
  assert.equal(pagesRefreshDue(controllerAt('2026-07-16T11:25:00Z')), false);
  assert.equal(pagesRefreshDue(controllerAt('2026-07-16T11:30:00Z')), true);
});

test('pages refresh interval never drops below the five-minute cron cadence', () => {
  assert.equal(pagesRefreshDue(controllerAt('2026-07-16T11:25:00Z'), 1), true);
});
