import test from 'node:test';
import assert from 'node:assert/strict';

import { healthResponseStatus } from '../worker/src/health-alert-index.js';

test('health response status falls back to 500 for malformed upstream status', () => {
  assert.equal(healthResponseStatus(undefined, { collector_health_ok: true }), 500);
  assert.equal(healthResponseStatus(99, { collector_health_ok: true }), 500);
  assert.equal(healthResponseStatus(600, { collector_health_ok: true }), 500);
});

test('unhealthy collector still overrides otherwise successful health responses', () => {
  assert.equal(healthResponseStatus(200, { collector_health_ok: false }), 503);
  assert.equal(healthResponseStatus(204, { collector_health_ok: false }), 503);
});

test('non-success upstream health status is preserved', () => {
  assert.equal(healthResponseStatus(404, { collector_health_ok: false }), 404);
  assert.equal(healthResponseStatus(503, { collector_health_ok: true }), 503);
});
