import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingAlertIsObsolete } from '../worker/src/health-alert-guard.js';

test('queued outage alert is obsolete after a newer successful collection', () => {
  assert.equal(pendingAlertIsObsolete({
    event_kind: 'alert',
    baseline_success_at: 100,
    last_success_at: 101,
  }), true);
  assert.equal(pendingAlertIsObsolete({
    event_kind: 'alert',
    baseline_success_at: null,
    last_success_at: 101,
  }), true);
});

test('queued outage alert remains valid until a newer success exists', () => {
  assert.equal(pendingAlertIsObsolete({
    event_kind: 'alert',
    baseline_success_at: 100,
    last_success_at: 100,
  }), false);
  assert.equal(pendingAlertIsObsolete({
    event_kind: 'alert',
    baseline_success_at: 100,
    last_success_at: null,
  }), false);
  assert.equal(pendingAlertIsObsolete({
    event_kind: 'recovery',
    baseline_success_at: 100,
    last_success_at: 101,
  }), false);
});
