import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildAlertEmail,
  buildRecoveryEmail,
  evaluateCollectorHealth,
  healthAlertConfig,
} from '../worker/src/health-alert.js';

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

test('last run is used until the first successful collection exists', () => {
  const health = evaluateCollectorHealth({ last_run_at: 1_000 }, 2_000, HOUR);
  assert.equal(health.referenceAt, 1_000);
  assert.equal(health.stale, false);
});

test('Resend remains disabled until both recipient and secret exist', () => {
  assert.equal(healthAlertConfig({ HEALTH_ALERT_TO: 'owner@example.com' }).enabled, false);
  assert.equal(healthAlertConfig({
    HEALTH_ALERT_TO: 'owner@example.com',
    RESEND_API_KEY: 're_test',
  }).enabled, true);
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
  assert.match(alert.body, /Health: https:\/\/skrzk\.pages\.dev\/health/);

  const recovery = buildRecoveryEmail(
    { ...health, lastSuccessAt: now + 60_000 },
    { incident_started_at: now },
    now + 120_000,
  );
  assert.match(recovery.subject, /復旧/);
  assert.match(recovery.idempotencyKey, /^stationhead-monitor-recovered-/);
});

test('health alert migration creates a single incident-state table', () => {
  const sql = readFileSync(new URL('../database/migrations/017_resend_health_alert.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sh_health_alert_state/);
  assert.match(sql, /'stationhead-collector'/);
  assert.match(sql, /incident_open INTEGER NOT NULL DEFAULT 0/);
});
