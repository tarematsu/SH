import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildAlertEmail,
  buildRecoveryEmail,
  evaluateCollectorHealth,
  healthAlertConfig,
} from '../worker/src/health-alert.js';
import {
  healthResponseStatus,
  sanitizeHealthPayload,
} from '../worker/src/health-alert-index.js';

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

test('Resend config requires recipient and secret and clamps timeout', () => {
  assert.equal(healthAlertConfig({ HEALTH_ALERT_TO: 'owner@example.com' }).enabled, false);
  const defaults = healthAlertConfig({
    HEALTH_ALERT_TO: 'owner@example.com',
    RESEND_API_KEY: 're_test',
  });
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.resendTimeoutMs, 10_000);
  assert.equal(healthAlertConfig({ HEALTH_ALERT_RESEND_TIMEOUT_MS: 1 }).resendTimeoutMs, 1_000);
  assert.equal(healthAlertConfig({ HEALTH_ALERT_RESEND_TIMEOUT_MS: 999_999 }).resendTimeoutMs, 30_000);
});

test('alert and recovery emails use stable incident keys', () => {
  const now = Date.UTC(2026, 6, 2, 14, 0, 0);
  const health = evaluateCollectorHealth({
    last_run_at: now - 5_000,
    last_success_at: now - HOUR,
  }, now, HOUR);
  const alert = buildAlertEmail(health, now, HOUR);
  assert.equal(alert.incidentStartedAt, now);
  assert.equal(alert.idempotencyKey, `stationhead-monitor-down-${now}`);
  assert.match(alert.body, /Health: https:\/\/skrzk\.pages\.dev\/api\/health/);

  const recovery = buildRecoveryEmail(
    { ...health, lastSuccessAt: now + 60_000 },
    { incident_started_at: now },
    now + 120_000,
  );
  assert.match(recovery.subject, /復旧/);
  assert.match(recovery.body, /Health: https:\/\/skrzk\.pages\.dev\/api\/health/);
  assert.match(recovery.idempotencyKey, /^stationhead-monitor-recovered-/);
});

test('worker health removes raw errors and returns 503 for collector failure', () => {
  assert.deepEqual(sanitizeHealthPayload({
    ok: true,
    last_error: 'secret upstream detail',
    official_news_last_error: null,
    cloud_host_last_error: 'private detail',
  }), {
    ok: true,
    last_error_present: true,
    official_news_last_error_present: false,
    cloud_host_last_error_present: true,
  });
  assert.equal(healthResponseStatus(200, { collector_health_ok: false }), 503);
  assert.equal(healthResponseStatus(200, { collector_health_ok: true }), 200);
  assert.equal(healthResponseStatus(500, { collector_health_ok: false }), 500);
});

test('public health uses current snapshot table and hides raw errors', () => {
  const source = readFileSync(new URL('../site/functions/api/health.js', import.meta.url), 'utf8');
  assert.match(source, /FROM sh_channel_snapshots/);
  assert.doesNotMatch(source, /FROM snapshots/);
  assert.match(source, /collector_last_error_present/);
  assert.match(source, /alert_last_error_present/);
  assert.doesNotMatch(source, /collector_last_error:\s*state/);
  assert.doesNotMatch(source, /alert_last_error:\s*state/);
  assert.match(source, /error:\s*'health_check_failed'/);
});

test('health alert uses an atomic initial window and a bounded Resend request', () => {
  const source = readFileSync(new URL('../worker/src/health-alert.js', import.meta.url), 'utf8');
  assert.match(source, /WHERE id=\? AND incident_started_at IS NULL/);
  assert.match(source, /AbortSignal\.timeout\(cfg\.resendTimeoutMs\)/);
});

test('health alert migration creates a single incident-state table', () => {
  const sql = readFileSync(new URL('../database/migrations/017_resend_health_alert.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sh_health_alert_state/);
  assert.match(sql, /'stationhead-collector'/);
  assert.match(sql, /incident_open INTEGER NOT NULL DEFAULT 0/);
});
