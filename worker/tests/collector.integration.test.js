import assert from 'node:assert/strict';
import test from 'node:test';

import { EMAIL_RECAP_UPSERT_SQL } from '../src/email-recap-index.js';
import {
  healthResponseStatus,
  sanitizeHealthPayload,
} from '../src/health-alert-index.js';
import {
  diagnoseCollectorFailure,
  diagnosisFromState,
  isD1Failure,
  recordCollectorFailure,
  sanitizeFailureDetail,
} from '../src/collector-failure.js';

class RecordingStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async run() {
    this.db.calls.push({ kind: 'run', sql: this.sql, params: this.params });
    if (this.db.runError) throw this.db.runError;
    return { success: true, meta: { changes: this.db.changes } };
  }
}

class RecordingDb {
  constructor({ changes = 1, runError = null } = {}) {
    this.changes = changes;
    this.runError = runError;
    this.calls = [];
  }

  prepare(sql) {
    return new RecordingStatement(this, sql);
  }
}

test('email recap upsert skips unchanged conflict rows', () => {
  assert.match(EMAIL_RECAP_UPSERT_SQL, /ON CONFLICT\(source_key\) DO UPDATE SET/);
  assert.match(EMAIL_RECAP_UPSERT_SQL, /WHERE sh_email_stream_snapshots\.email_sent_at IS NOT excluded\.email_sent_at/);
  assert.match(EMAIL_RECAP_UPSERT_SQL, /validation_notes IS NOT excluded\.validation_notes/);
  assert.doesNotMatch(EMAIL_RECAP_UPSERT_SQL, /imported_at IS NOT excluded\.imported_at/);
});

test('health payload strips raw upstream errors while preserving boolean evidence', () => {
  const result = sanitizeHealthPayload({
    ok: true,
    last_error: 'Bearer secret-token',
    auth_last_error: '',
    public_value: 42,
  });
  assert.deepEqual(result, {
    ok: true,
    last_error_present: true,
    auth_last_error_present: false,
    public_value: 42,
  });
  assert.equal('last_error' in result, false);
});

test('health status is degraded only when the base response was otherwise healthy', () => {
  assert.equal(healthResponseStatus(200, { collector_health_ok: false }), 503);
  assert.equal(healthResponseStatus(204, { collector_health_ok: false }), 503);
  assert.equal(healthResponseStatus(500, { collector_health_ok: false }), 500);
  assert.equal(healthResponseStatus(200, { collector_health_ok: true }), 200);
});

test('collector diagnostics classify realistic upstream, auth, schema and network failures', () => {
  const scenarios = [
    ['no such table: sh_worker_collector_state', 'd1_read_collector_state', 'D1_SCHEMA_ERROR'],
    ['HTTP 401 authentication failed', 'sh_channel_request', 'STATIONHEAD_AUTH_ERROR'],
    ['Stationhead API status=429', 'sh_channel_request', 'STATIONHEAD_RATE_LIMIT'],
    ['Stationhead API 503', 'sh_channel_request', 'STATIONHEAD_UPSTREAM_ERROR'],
    ['AbortError: request timed out', 'sh_channel_request', 'STATIONHEAD_TIMEOUT'],
    ['fetch failed: DNS lookup error', 'sh_channel_request', 'NETWORK_ERROR'],
    ['missing required channel field', 'sh_channel_payload', 'STATIONHEAD_API_CHANGED'],
    ['D1 ingest failed while writing', 'd1_write_snapshot', 'D1_WRITE_ERROR'],
  ];

  for (const [message, stage, expected] of scenarios) {
    const diagnosis = diagnoseCollectorFailure(new Error(message), stage, 1_700_000_000_000);
    assert.equal(diagnosis.code, expected, `${message} should map to ${expected}`);
    assert.equal(diagnosis.stage, stage);
    assert.equal(diagnosis.at, 1_700_000_000_000);
    assert.ok(diagnosis.summary);
    assert.ok(diagnosis.hint);
  }
});

test('failure details redact authorization material and enforce a bounded payload', () => {
  const raw = [
    'Authorization: super-secret-token',
    'Bearer abcdefghijklmnopqrstuvwxyz.1234567890',
    're_abcdefghijklmnop',
    'x'.repeat(2_000),
  ].join(' ');
  const sanitized = sanitizeFailureDetail(raw);
  assert.equal(sanitized.includes('super-secret-token'), false);
  assert.equal(sanitized.includes('re_abcdefghijklmnop'), false);
  assert.match(sanitized, /redacted/);
  assert.ok(sanitized.length <= 800);
});

test('recordCollectorFailure produces an idempotent upsert with normalized diagnosis data', async () => {
  const db = new RecordingDb();
  const at = 1_700_000_001_234;
  const result = await recordCollectorFailure(
    { DB: db },
    new Error('HTTP 429 from Stationhead'),
    'sh_channel_request',
    'integration-test',
    at,
  );

  assert.equal(result.recorded, true);
  assert.equal(result.diagnosis.code, 'STATIONHEAD_RATE_LIMIT');
  assert.equal(db.calls.length, 1);
  const call = db.calls[0];
  assert.match(call.sql, /INSERT INTO sh_collector_failure_state/);
  assert.match(call.sql, /ON CONFLICT\(id\) DO UPDATE/);
  assert.equal(call.params[0], 'stationhead');
  assert.equal(call.params[1], at);
  assert.equal(call.params[2], at);
  assert.equal(call.params[3], 'STATIONHEAD_RATE_LIMIT');
  assert.equal(call.params[4], 'sh_channel_request');
  assert.equal(call.params[8], 'integration-test');
  assert.equal(call.params[9], at);
});

test('recordCollectorFailure reports missing and failing D1 without throwing away diagnosis', async () => {
  const missing = await recordCollectorFailure({}, new Error('network error'));
  assert.equal(missing.recorded, false);
  assert.equal(missing.recordError, 'DB binding missing');
  assert.equal(missing.diagnosis.code, 'NETWORK_ERROR');

  const db = new RecordingDb({ runError: new Error('D1_ERROR authorization=hidden-secret') });
  const failed = await recordCollectorFailure({ DB: db }, new Error('timeout'), 'sh_auth');
  assert.equal(failed.recorded, false);
  assert.equal(failed.diagnosis.code, 'STATIONHEAD_AUTH_ERROR');
  assert.equal(failed.recordError.includes('hidden-secret'), false);
});

test('diagnosisFromState preserves active incidents and ignores stale recovered errors', () => {
  const active = diagnosisFromState({
    last_success_at: 1_000,
    failure_last_at: 2_000,
    failure_first_at: 1_500,
    failure_code: 'STATIONHEAD_TIMEOUT',
    failure_stage: 'sh_channel_request',
    failure_detail: 'request timed out',
    failure_count: 4,
    failure_source: 'cloudflare',
  });
  assert.equal(active.code, 'STATIONHEAD_TIMEOUT');
  assert.equal(active.firstAt, 1_500);
  assert.equal(active.count, 4);
  assert.equal(active.source, 'cloudflare');
  assert.equal(isD1Failure(active), false);

  const recovered = diagnosisFromState({
    last_success_at: 3_000,
    failure_last_at: 2_000,
    failure_code: 'D1_READ_ERROR',
  });
  assert.equal(recovered, null);

  const staleCollectorError = diagnosisFromState({
    last_success_at: 3_000,
    last_run_at: 2_000,
    last_error: 'Stationhead API 503',
  });
  assert.equal(staleCollectorError, null);

  const activeCollectorError = diagnosisFromState({
    last_success_at: 3_000,
    last_run_at: 4_000,
    last_error: 'Stationhead API 503',
  });
  assert.equal(activeCollectorError.code, 'STATIONHEAD_UPSTREAM_ERROR');
  assert.equal(activeCollectorError.at, 4_000);
});
