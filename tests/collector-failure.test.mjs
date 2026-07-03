import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  diagnoseCollectorFailure,
  diagnosisFromState,
  failureEmailLines,
  sanitizeFailureDetail,
} from '../worker/src/collector-failure.js';
import { alignFailureStartWithLastSuccess } from '../worker/src/health-alert-index.js';
import { validateChannelPayload } from '../worker/src/index.js';

const MIGRATION = new URL('../database/migrations/019_collector_failure_diagnostics.sql', import.meta.url);

function alignmentDb({ changes = 1 } = {}) {
  let statement = '';
  let bound = [];
  return {
    get statement() { return statement; },
    get bound() { return bound; },
    env: {
      DB: {
        prepare(sql) {
          statement = sql;
          return {
            bind(...values) {
              bound = values;
              return { run: async () => ({ meta: { changes } }) };
            },
          };
        },
      },
    },
  };
}

test('classifies D1 reads and writes separately', () => {
  const read = diagnoseCollectorFailure(new Error('D1_ERROR: database unavailable'), 'd1_read_collector_state', 1000);
  assert.equal(read.code, 'D1_READ_ERROR');
  assert.match(read.summary, /読み込めません/);

  const write = diagnoseCollectorFailure(new Error('D1 ingest failed 500'), 'd1_write_snapshot', 2000);
  assert.equal(write.code, 'D1_WRITE_ERROR');
  assert.match(write.summary, /保存できません/);
});

test('classifies Stationhead authentication, API changes, rate limits and timeouts', () => {
  assert.equal(
    diagnoseCollectorFailure(new Error('guest login failed: status=401'), 'stationhead_auth').code,
    'STATIONHEAD_AUTH_ERROR',
  );
  assert.equal(
    diagnoseCollectorFailure(new Error('Stationhead API 404: channel lookup'), 'stationhead_channel_request').code,
    'STATIONHEAD_API_CHANGED',
  );
  assert.equal(
    diagnoseCollectorFailure(new Error('Stationhead API 429'), 'stationhead_channel_request').code,
    'STATIONHEAD_RATE_LIMIT',
  );
  assert.equal(
    diagnoseCollectorFailure(new Error('The operation was aborted due to timeout'), 'stationhead_channel_request').code,
    'STATIONHEAD_TIMEOUT',
  );
  assert.equal(
    diagnoseCollectorFailure(new Error('Stationhead channel response shape changed'), 'stationhead_channel_payload').code,
    'STATIONHEAD_API_CHANGED',
  );
});

test('rejects successful Stationhead responses whose required shape changed', () => {
  assert.throws(() => validateChannelPayload({}, 'buddies'), /channel id is missing/);
  assert.throws(
    () => validateChannelPayload({ id: 1, alias: 'buddies' }, 'buddies'),
    /current_station fields are missing/,
  );
  assert.throws(
    () => validateChannelPayload({ id: 1, alias: 'renamed', current_station: null }, 'buddies'),
    /expected alias=buddies/,
  );
  const valid = { id: 1, alias: 'buddies', current_station: null };
  assert.equal(validateChannelPayload(valid, 'buddies'), valid);
});

test('redacts credentials from stored failure details', () => {
  const sanitized = sanitizeFailureDetail('authorization: Bearer placeholder-token-value');
  assert.doesNotMatch(sanitized, /placeholder-token-value/);
  assert.match(sanitized, /redacted/);
});

test('structured failure state takes priority and produces useful email lines', () => {
  const diagnosis = diagnosisFromState({
    last_success_at: 1000,
    failure_first_at: 1500,
    failure_last_at: 2500,
    failure_code: 'STATIONHEAD_API_CHANGED',
    failure_stage: 'stationhead_channel_payload',
    failure_summary: 'Stationhead APIのレスポンス形式が変わった可能性があります',
    failure_detail: 'channel_id is missing',
    failure_hint: 'JSON構造を確認してください',
    failure_count: 4,
    failure_source: 'scheduled-guard',
  });
  assert.equal(diagnosis.code, 'STATIONHEAD_API_CHANGED');
  assert.equal(diagnosis.firstAt, 1500);
  assert.equal(diagnosis.count, 4);
  const body = failureEmailLines(diagnosis).join('\n');
  assert.match(body, /推定原因/);
  assert.match(body, /失敗段階/);
  assert.match(body, /連続失敗: 4回/);
  assert.match(body, /JSON構造を確認/);
});

test('authentication control error is used when the collector never starts', () => {
  const diagnosis = diagnosisFromState({
    last_success_at: 1000,
    auth_last_attempt_at: 2000,
    auth_last_error: 'Stationhead authentication failed: guest token failed: status=403',
  });
  assert.equal(diagnosis.code, 'STATIONHEAD_AUTH_ERROR');
  assert.equal(diagnosis.stage, 'stationhead_auth');
});

test('collector success at the same millisecond suppresses stale failure evidence', () => {
  assert.equal(diagnosisFromState({
    last_success_at: 2000,
    failure_first_at: 1000,
    failure_last_at: 2000,
    failure_code: 'STATIONHEAD_TIMEOUT',
    failure_stage: 'stationhead_channel_request',
    auth_last_attempt_at: 2000,
    auth_last_error: 'guest token failed: status=403',
    last_run_at: 2000,
    last_error: 'Stationhead API 500',
  }), null);

  assert.equal(diagnosisFromState({
    last_success_at: 2000,
    failure_last_at: 2001,
    failure_code: 'STATIONHEAD_TIMEOUT',
    failure_stage: 'stationhead_channel_request',
  }).code, 'STATIONHEAD_TIMEOUT');
});

test('failure start uses the just-recorded event even when the loaded state is stale', async () => {
  const db = alignmentDb();

  assert.equal(await alignFailureStartWithLastSuccess(
    db.env,
    { last_success_at: 1000, failure_last_at: null },
    { diagnosis: { at: 2000 } },
    3000,
  ), true);
  assert.match(db.statement, /first_failure_at=CASE/);
  assert.match(db.statement, /first_failure_at IS NULL/);
  assert.deepEqual(db.bound, [1000, 1000, 3000, 1000]);

  assert.equal(await alignFailureStartWithLastSuccess(
    db.env,
    { last_success_at: 2000, failure_last_at: null },
    { diagnosis: { at: 1000 } },
    3000,
  ), false);
});

test('failure start alignment handles NULL first_failure_at explicitly', async () => {
  const db = alignmentDb();

  assert.equal(await alignFailureStartWithLastSuccess(
    db.env,
    { last_success_at: 1000, failure_last_at: 2000 },
    null,
    3000,
  ), true);

  assert.match(db.statement, /WHEN first_failure_at IS NULL OR first_failure_at>\?/);
  assert.doesNotMatch(db.statement, /first_failure_at=MIN\(first_failure_at,\?\)/);
  assert.deepEqual(db.bound, [1000, 1000, 3000, 1000]);
});

test('alignment reports false when the diagnostic row was not updated', async () => {
  const db = alignmentDb({ changes: 0 });
  assert.equal(await alignFailureStartWithLastSuccess(
    db.env,
    { last_success_at: 1000, failure_last_at: 2000 },
    null,
    3000,
  ), false);
});

test('diagnostic migration is repeatable', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(sql);
  db.exec(sql);
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sh_collector_failure_state'").get();
  assert.equal(table.name, 'sh_collector_failure_state');
  const columns = db.prepare("PRAGMA table_info('sh_collector_failure_state')").all().map((row) => row.name);
  assert.ok(columns.includes('code'));
  assert.ok(columns.includes('stage'));
  assert.ok(columns.includes('consecutive_failures'));
  db.close();
});

test('scheduled wrapper prepares detailed messages and has a D1 emergency path', () => {
  const diagnosticsSource = readFileSync(new URL('../worker/src/collector-diagnostics.js', import.meta.url), 'utf8');
  const wrapperSource = readFileSync(new URL('../worker/src/health-alert-index.js', import.meta.url), 'utf8');
  assert.match(diagnosticsSource, /prepareDetailedCollectorAlert/);
  assert.match(diagnosticsSource, /failureEmailLines/);
  assert.match(diagnosticsSource, /sendEmergencyD1Alert/);
  assert.match(diagnosticsSource, /D1を経由せずResendへ直接送信/);
  assert.match(wrapperSource, /collector_false_recovery_cancelled/);
  assert.match(wrapperSource, /collector_generic_alert_suppressed/);
  assert.match(wrapperSource, /alignFailureStartWithLastSuccess/);
});
