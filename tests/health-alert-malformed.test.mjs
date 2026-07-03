import test from 'node:test';
import assert from 'node:assert/strict';
import { retireRecoveredPendingAlert } from '../worker/src/health-alert-guard.js';

test('obsolete pending outage alert without a delivery key is not mutated', async () => {
  let writes = 0;
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                assert.match(sql, /FROM sh_health_alert_delivery delivery/);
                return {
                  last_success_at: 101,
                  event_kind: 'alert',
                  incident_started_at: 90,
                  baseline_success_at: 100,
                  idempotency_key: null,
                  delivery_last_error: 'Resend HTTP 500',
                  delivery_updated_at: 0,
                };
              },
              async run() {
                writes += 1;
                throw new Error('malformed alert rows must be skipped before writes');
              },
            };
          },
        };
      },
    },
  };

  assert.equal(await retireRecoveredPendingAlert(env, 200), false);
  assert.equal(writes, 0);
});
