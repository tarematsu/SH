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
import { healthStaleMs } from '../site/functions/api/health.js';

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

test('alert stores the failure start and recovery reports the full duration', () => {
  const now = Date.UTC(2026, 6, 2, 14, 0, 0);
  const incidentStartedAt = now - HOUR;
  const health = evaluateCollectorHealth({
    last_run_at: now - 5_000,
    last_success_at: incidentStartedAt,
  }, now, HOUR);
  const alert = buildAlertEmail(health, now, HOUR);
  assert.equal(alert.incidentStartedAt, incidentStartedAt);
  assert.equal(alert.thresholdReachedAt, now);
  assert.equal(alert.idempotencyKey, `stationhead-monitor-down-${incidentStartedAt}`);
  assert.match(alert.body, /停止判定到達:/);
  assert.match(alert.body, /Health: https:\/\/skrzk\.pages\.dev\/api\/health/);

  const recovery = buildRecoveryEmail(
    { ...health, lastSuccessAt: now + HOUR },
    { incident_started_at: incidentStartedAt },
    now + HOUR,
  );
  assert.match(recovery.subject, /復旧/);
  assert.match(recovery.body, /障害時間: 2時間0分/);
  assert.match(recovery.body, /Health: https:\/\/skrzk\.pages\.dev\/api\/health/);
  assert.match(recovery.idempotencyKey, /^stationhead-monitor-recovered-/);
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

test('public health uses current snapshot table and hides raw errors', () => {
  const source = readFileSync(new URL('../site/functions/api/health.js', import.meta.url), 'utf8');
  assert.match(source, /FROM sh_channel_snapshots/);
  assert.doesNotMatch(source, /FROM snapshots/);
  assert.match(source, /collector_last_error_present/);
  assert.match(source, /alert_last_error_present/);
  assert.doesNotMatch(source, /collector_last_error:\s*state/);
  assert.doesNotMatch(source, /alert_last_error:\s*state/);
  assert.match(source, /healthStaleMs\(context\.env\)/);
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
