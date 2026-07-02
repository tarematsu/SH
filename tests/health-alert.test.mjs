import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  buildAlertEmail,
  buildRecoveryEmail,
  evaluateCollectorHealth,
  hasCollectorRecovered,
  healthAlertConfig,
  storedDeliveryEmail,
} from '../worker/src/health-alert.js';
import {
  healthResponseStatus,
  sanitizeHealthPayload,
} from '../worker/src/health-alert-index.js';
import {
  healthStaleMs,
  publicCollectorHealth,
} from '../site/functions/api/health.js';

const HOUR = 60 * 60 * 1000;

test('collector health is fresh before the one-hour threshold', () => {
  const now = 2 * HOUR;
  const health = evaluateCollectorHealth({ last_success_at: now - HOUR + 1 }, now, HOUR);
  assert.equal(health.stale, false);
  assert.equal(health.ageMs, HOUR - 1);
});

test('collector health becomes stale at the exact threshold', () => {
  const now = 2 * HOUR;
  const health = evaluateCollectorHealth({
    last_run_at: now - 1_000,
    last_success_at: now - HOUR,
    last_error: 'upstream failed',
  }, now, HOUR);
  assert.equal(health.stale, true);
  assert.equal(health.referenceAt, now - HOUR);
  assert.equal(health.lastError, 'upstream failed');
});

test('failed runs do not postpone the initial no-success alert window', () => {
  const now = 3 * HOUR;
  const health = evaluateCollectorHealth({
    last_run_at: now - 1_000,
    last_success_at: null,
    incident_started_at: now - HOUR,
  }, now, HOUR);
  assert.equal(health.referenceAt, now - HOUR);
  assert.equal(health.ageMs, HOUR);
  assert.equal(health.stale, true);
});

test('collector without success or an initialized alert window is not treated as fresh', () => {
  const health = evaluateCollectorHealth({ last_run_at: 1_000 }, 2_000, HOUR);
  assert.equal(health.referenceAt, null);
  assert.equal(health.ageMs, null);
  assert.equal(health.stale, false);
});

test('Resend config requires recipient and key and clamps timeout', () => {
  assert.equal(healthAlertConfig({ HEALTH_ALERT_TO: 'owner@example.com' }).enabled, false);
  const defaults = healthAlertConfig({
    HEALTH_ALERT_TO: 'owner@example.com',
    RESEND_API_KEY: 'test-key',
  });
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.resendTimeoutMs, 10_000);
  assert.equal(healthAlertConfig({ HEALTH_ALERT_RESEND_TIMEOUT_MS: 1 }).resendTimeoutMs, 1_000);
  assert.equal(healthAlertConfig({ HEALTH_ALERT_RESEND_TIMEOUT_MS: 999_999 }).resendTimeoutMs, 30_000);
});

test('recovery requires a success newer than the opened incident baseline', () => {
  const state = {
    incident_open: 1,
    incident_started_at: 10_000,
    last_observed_success_at: 10_000,
    last_alert_at: 20_000,
  };
  assert.equal(hasCollectorRecovered(state, { lastSuccessAt: 10_000 }), false);
  assert.equal(hasCollectorRecovered(state, { lastSuccessAt: 10_001 }), true);
  assert.equal(hasCollectorRecovered({ incident_open: 1 }, { lastSuccessAt: 50_000 }), false);
});

test('raising the threshold does not create a false recovery', () => {
  const now = 2 * HOUR;
  const state = {
    incident_open: 1,
    incident_started_at: HOUR / 2,
    last_observed_success_at: HOUR / 2,
    last_success_at: HOUR / 2,
  };
  const health = evaluateCollectorHealth(state, now, 2 * HOUR);
  assert.equal(health.stale, false);
  assert.equal(hasCollectorRecovered(state, health), false);

  const publicHealth = publicCollectorHealth(state, now, 2 * HOUR);
  assert.equal(publicHealth.recoveryPending, false);
  assert.equal(publicHealth.healthy, false);
});

test('alert and recovery builders create stable event identifiers', () => {
  const now = Date.UTC(2026, 6, 2, 14, 0, 0);
  const incidentStartedAt = now - HOUR;
  const health = evaluateCollectorHealth({
    last_run_at: now - 5_000,
    last_success_at: incidentStartedAt,
  }, now, HOUR);
  const alert = buildAlertEmail(health, now, HOUR);
  assert.equal(alert.eventKind, 'alert');
  assert.equal(alert.incidentStartedAt, incidentStartedAt);
  assert.equal(alert.idempotencyKey, `stationhead-monitor-down-${incidentStartedAt}-${HOUR}`);
  assert.match(alert.body, /停止判定到達:/);
  assert.match(alert.body, /Health: https:\/\/skrzk\.pages\.dev\/api\/health/);

  const state = {
    incident_started_at: incidentStartedAt,
    last_observed_success_at: incidentStartedAt,
    last_alert_at: now,
  };
  const recovery1 = buildRecoveryEmail({ ...health, lastSuccessAt: now + HOUR }, state, now + HOUR);
  const recovery2 = buildRecoveryEmail({ ...health, lastSuccessAt: now + 2 * HOUR }, state, now + 2 * HOUR);
  assert.equal(recovery1.eventKind, 'recovery');
  assert.equal(recovery1.idempotencyKey, recovery2.idempotencyKey);
  assert.equal(recovery1.idempotencyKey, `stationhead-monitor-recovered-${incidentStartedAt}`);
});

test('stored delivery payload is reused exactly for retries', () => {
  const stored = storedDeliveryEmail({
    pending_event_kind: 'alert',
    pending_subject: 'subject',
    pending_body: 'body created once',
    pending_idempotency_key: 'event/123',
    pending_incident_started_at: 100,
    pending_observed_at: 200,
    pending_baseline_success_at: 100,
    pending_stale_ms: HOUR,
  });
  assert.deepEqual(stored, {
    eventKind: 'alert',
    subject: 'subject',
    body: 'body created once',
    idempotencyKey: 'event/123',
    incidentStartedAt: 100,
    observedAt: 200,
    baselineSuccessAt: 100,
    staleMs: HOUR,
  });
});

test('worker health removes raw error text and returns 503 for collector failure', () => {
  assert.deepEqual(sanitizeHealthPayload({
    ok: true,
    last_error: 'a',
    auth_last_error: 'b',
    browser_last_auth_error: 'c',
    official_news_last_error: null,
    cloud_host_last_error: 'd',
  }), {
    ok: true,
    last_error_present: true,
    auth_last_error_present: true,
    browser_last_auth_error_present: true,
    official_news_last_error_present: false,
    cloud_host_last_error_present: true,
  });
  assert.equal(healthResponseStatus(200, { collector_health_ok: false }), 503);
  assert.equal(healthResponseStatus(200, { collector_health_ok: true }), 200);
  assert.equal(healthResponseStatus(500, { collector_health_ok: false }), 500);
});

test('Pages and Worker use the same configurable stale threshold', () => {
  assert.equal(healthStaleMs({}), HOUR);
  assert.equal(healthStaleMs({ HEALTH_ALERT_STALE_MS: HOUR * 2 }), HOUR * 2);
  assert.equal(healthStaleMs({ HEALTH_ALERT_STALE_MS: 1 }), 5 * 60 * 1000);

  const workerConfig = readFileSync(new URL('../worker/wrangler.jsonc', import.meta.url), 'utf8');
  const pagesConfig = readFileSync(new URL('../site/wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(workerConfig, /"HEALTH_ALERT_STALE_MS"\s*:\s*3600000/);
  assert.match(pagesConfig, /"HEALTH_ALERT_STALE_MS"\s*:\s*3600000/);
});

test('public health uses current snapshot table and exposes delivery state without raw errors', () => {
  const source = readFileSync(new URL('../site/functions/api/health.js', import.meta.url), 'utf8');
  assert.match(source, /FROM sh_channel_snapshots/);
  assert.doesNotMatch(source, /FROM snapshots/);
  assert.match(source, /sh_health_alert_delivery/);
  assert.match(source, /alert_delivery_pending/);
  assert.match(source, /collector_last_error_present/);
  assert.match(source, /alert_last_error_present/);
  assert.doesNotMatch(source, /collector_last_error:\s*state/);
  assert.doesNotMatch(source, /alert_last_error:\s*state/);
  assert.match(source, /healthStaleMs\(context\.env\)/);
  assert.match(source, /error:\s*'health_check_failed'/);
});

test('health delivery uses a stored payload and transactional finalization', () => {
  const source = readFileSync(new URL('../worker/src/health-alert.js', import.meta.url), 'utf8');
  assert.match(source, /INSERT OR IGNORE INTO sh_health_alert_delivery/);
  assert.match(source, /pending_subject/);
  assert.match(source, /pending_body/);
  assert.match(source, /await env\.DB\.batch\(\[/);
  assert.match(source, /DELETE FROM sh_health_alert_delivery/);
  assert.match(source, /AbortSignal\.timeout\(cfg\.resendTimeoutMs\)/);
});

test('health alert migrations create repeatable state and delivery tables', () => {
  const stateSql = readFileSync(new URL('../database/migrations/017_resend_health_alert.sql', import.meta.url), 'utf8');
  const deliverySql = readFileSync(new URL('../database/migrations/018_health_alert_delivery.sql', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  for (let index = 0; index < 2; index += 1) {
    db.exec(stateSql);
    db.exec(deliverySql);
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map((row) => row.name);
  assert.ok(tables.includes('sh_health_alert_state'));
  assert.ok(tables.includes('sh_health_alert_delivery'));
  const state = db.prepare("SELECT incident_open FROM sh_health_alert_state WHERE id='stationhead-collector'").get();
  assert.equal(state.incident_open, 0);
  db.close();
});
