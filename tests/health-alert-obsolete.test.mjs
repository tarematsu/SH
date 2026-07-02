import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pendingAlertIsObsolete,
  retireRecoveredPendingAlert,
} from '../worker/src/health-alert-guard.js';

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

function healthAlertDb({
  lastSuccessAt = 101,
  baselineSuccessAt = 100,
  stateUpdateChanges = 1,
  deliveryUpdateChanges = 1,
} = {}) {
  const state = {
    id: 'stationhead-collector',
    incident_open: 0,
    incident_started_at: null,
    last_observed_success_at: baselineSuccessAt,
    last_error: 'Resend HTTP 500',
    updated_at: 0,
  };
  const delivery = {
    id: 'stationhead-collector',
    event_kind: 'alert',
    incident_started_at: 90,
    baseline_success_at: baselineSuccessAt,
    idempotency_key: 'stationhead-monitor-down-90-3600000',
    last_error: 'Resend HTTP 500',
    updated_at: 0,
  };
  const db = {
    state,
    delivery,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              assert.match(sql, /FROM sh_health_alert_delivery delivery/);
              if (delivery.id !== args[0]) return null;
              return {
                last_success_at: lastSuccessAt,
                event_kind: delivery.event_kind,
                incident_started_at: delivery.incident_started_at,
                baseline_success_at: delivery.baseline_success_at,
                idempotency_key: delivery.idempotency_key,
              };
            },
            async run() {
              if (/UPDATE sh_health_alert_state/.test(sql)) {
                const [incidentStartedAt, observedSuccessAt, updatedAt, id,, idempotencyKey] = args;
                if (id !== state.id || delivery.id !== id || delivery.idempotency_key !== idempotencyKey || !stateUpdateChanges) {
                  return { meta: { changes: 0 } };
                }
                state.incident_open = 1;
                state.incident_started_at = incidentStartedAt;
                state.last_observed_success_at = observedSuccessAt;
                state.last_error = null;
                state.updated_at = updatedAt;
                return { meta: { changes: stateUpdateChanges } };
              }
              if (/UPDATE sh_health_alert_delivery/.test(sql)) {
                const [retiredId, updatedAt, id, idempotencyKey] = args;
                if (delivery.id !== id || delivery.idempotency_key !== idempotencyKey || !deliveryUpdateChanges) {
                  return { meta: { changes: 0 } };
                }
                delivery.id = retiredId;
                delivery.last_error = 'retired_after_recovery';
                delivery.updated_at = updatedAt;
                return { meta: { changes: deliveryUpdateChanges } };
              }
              throw new Error(`unexpected sql: ${sql}`);
            },
          };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return db;
}

test('obsolete pending outage alert is retired and preserved as recovery pending state', async () => {
  const db = healthAlertDb();

  assert.equal(await retireRecoveredPendingAlert({ DB: db }, 200), true);

  assert.equal(db.state.incident_open, 1);
  assert.equal(db.state.incident_started_at, 90);
  assert.equal(db.state.last_observed_success_at, 100);
  assert.equal(db.state.last_error, null);
  assert.match(db.delivery.id, /^retired-200-/);
  assert.equal(db.delivery.last_error, 'retired_after_recovery');
});

test('current pending outage alert is not retired before a newer success exists', async () => {
  const db = healthAlertDb({ lastSuccessAt: 100, baselineSuccessAt: 100 });

  assert.equal(await retireRecoveredPendingAlert({ DB: db }, 200), false);

  assert.equal(db.state.incident_open, 0);
  assert.equal(db.delivery.id, 'stationhead-collector');
  assert.equal(db.delivery.last_error, 'Resend HTTP 500');
});

test('partial pending outage retirement is not reported as completed', async () => {
  const db = healthAlertDb({ deliveryUpdateChanges: 0 });

  assert.equal(await retireRecoveredPendingAlert({ DB: db }, 200), false);

  assert.equal(db.state.incident_open, 1);
  assert.equal(db.delivery.id, 'stationhead-collector');
  assert.equal(db.delivery.last_error, 'Resend HTTP 500');
});

test('stale pending outage state update is not reported as completed', async () => {
  const db = healthAlertDb({ stateUpdateChanges: 0 });

  assert.equal(await retireRecoveredPendingAlert({ DB: db }, 200), false);

  assert.equal(db.state.incident_open, 0);
  assert.match(db.delivery.id, /^retired-200-/);
  assert.equal(db.delivery.last_error, 'retired_after_recovery');
});
