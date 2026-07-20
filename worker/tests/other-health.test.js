import assert from 'node:assert/strict';
import test from 'node:test';

import { createOtherHealthApp } from '../src/other-health.js';

function healthyPrimaryDb() {
  const now = Date.now();
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('sh_collector_read_model')) {
            return { last_run_at: now, last_success_at: now, last_error_present: 0, updated_at: now };
          }
          if (sql.includes('FROM sh_minute_facts')) {
            return { channel_id: 318, station_id: 123, observed_at: now };
          }
          return null;
        },
      };
    },
  };
}

function healthyOtherDb(now = Date.now()) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...bound) { values = bound; return this; },
        async first() {
          if (sql.includes('collector_state.auth_token')) {
            return { auth_token: 'token', device_uid: 'device', control_id: 'stationhead' };
          }
          if (sql.includes('sh_health_alert_state')) return {};
          if (sql.includes('sh_official_news_monitor_state')) {
            return { last_check_at: now, last_success_at: now, upcoming_count: 0, active_count: 0 };
          }
          if (sql.includes('sh_cloud_host_monitor_state')) {
            return { phase: 'idle', last_success_at: now };
          }
          if (sql.includes('sh_collector_status')) {
            return {
              status: 'ok',
              last_attempt_at: now,
              last_success_at: now,
              task: values[0],
            };
          }
          return null;
        },
      };
    },
  };
}

function taskHealthDb(now, rows) {
  const db = healthyOtherDb(now);
  return {
    prepare(sql) {
      let values = [];
      const query = db.prepare(sql);
      return {
        bind(...bound) {
          values = bound;
          query.bind(...bound);
          return this;
        },
        async first() {
          if (sql.includes('sh_collector_status')) return rows[values[0]] || null;
          return query.first();
        },
      };
    },
  };
}

test('other health reports a healthy runtime', async () => {
  const response = await createOtherHealthApp().fetch(new Request('https://runtime.test/health'), {
    MINUTE_DB: healthyPrimaryDb(),
    OTHER_DB: healthyOtherDb(),
  }, {});
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.other_health_ok, true);
});

test('other health reports a missing OTHER_DB binding', async () => {
  const response = await createOtherHealthApp().fetch(new Request('https://runtime.test/health'), {
    MINUTE_DB: healthyPrimaryDb(),
  }, {});
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.ok, false);
  assert.equal(payload.other_health_ok, false);
  assert.equal(payload.official_news_setup_required, true);
  assert.equal(payload.cloud_host_setup_required, true);
});

test('other health exposes D1 failures without leaking error strings', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await createOtherHealthApp().fetch(new Request('https://runtime.test/health'), {
      MINUTE_DB: { prepare() { throw new Error('primary D1 unavailable'); } },
      OTHER_DB: healthyOtherDb(),
    }, {});
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.ok, false);
    assert.equal(payload.primary_health_error_present, true);
    assert.equal('primary_health_error' in payload, false);
  } finally {
    console.error = originalError;
  }
});

test('other health reports active monitor errors', async () => {
  const now = Date.now();
  const db = healthyOtherDb(now);
  const response = await createOtherHealthApp().fetch(new Request('https://runtime.test/health'), {
    MINUTE_DB: healthyPrimaryDb(),
    OTHER_DB: {
      prepare(sql) {
        if (!sql.includes('sh_official_news_monitor_state')) return db.prepare(sql);
        return {
          bind() { return this; },
          async first() { return { last_check_at: now, last_error: 'official probe failed' }; },
        };
      },
    },
  }, {});
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.other_health_ok, false);
  assert.equal(payload.official_news_last_error_present, true);
  assert.equal('official_news_last_error' in payload, false);
});

test('other health detects stopped cron and buddy playback failures independently', async () => {
  const now = Date.now();
  const app = createOtherHealthApp();
  const staleCron = await app.fetch(new Request('https://runtime.test/health'), {
    MINUTE_DB: healthyPrimaryDb(),
    OTHER_CRON_STALE_MS: 120_000,
    OTHER_DB: taskHealthDb(now, {
      'other-cron': { status: 'ok', last_attempt_at: now - 180_000, last_success_at: now - 180_000 },
      'buddy46-playback': { status: 'ok', last_attempt_at: now, last_success_at: now },
    }),
  }, {});
  const stalePayload = await staleCron.json();
  assert.equal(stalePayload.other_cron_health_ok, false);
  assert.equal(stalePayload.buddy_playback_health_ok, true);

  const buddyFailure = await app.fetch(new Request('https://runtime.test/health'), {
    MINUTE_DB: healthyPrimaryDb(),
    OTHER_DB: taskHealthDb(now, {
      'other-cron': { status: 'ok', last_attempt_at: now, last_success_at: now },
      'buddy46-playback': { status: 'error', last_attempt_at: now, last_error: 'playback failed' },
    }),
  }, {});
  const buddyPayload = await buddyFailure.json();
  assert.equal(buddyPayload.other_cron_health_ok, true);
  assert.equal(buddyPayload.buddy_playback_health_ok, false);
  assert.equal(buddyPayload.buddy_playback_last_error_present, true);
  assert.equal('buddy_playback_last_error' in buddyPayload, false);
});
