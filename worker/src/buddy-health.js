import { diagnoseCollectorFailure, sanitizeFailureDetail } from './collector-failure.js';

export const BUDDY_HEALTH_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_collector_status (
  collector_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_error TEXT,
  failure_code TEXT,
  failure_stage TEXT,
  failure_summary TEXT,
  failure_hint TEXT,
  tracks INTEGER,
  changed INTEGER,
  updated_at INTEGER NOT NULL
)`;

let healthSchemaReady = false;

export function buddyHealthId(alias = 'buddy46') {
  return `${String(alias || 'buddy46').trim().toLowerCase()}-playback`;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function failureStage(error) {
  const detail = String(error?.message || error || '');
  if (/Stationhead buddy playback API\s+\d+|buddy playback API\s+\d+|Not in database/i.test(detail)) {
    return 'sh_channel_request';
  }
  if (/401|403|auth|token|session|guest login|guest verification/i.test(detail)) {
    return 'sh_auth';
  }
  if (/D1|SQLITE|database|no such table|no such column/i.test(detail)) {
    return 'd1_write_queue';
  }
  if (/queue|payload|response|alias|current_station/i.test(detail)) {
    return 'sh_channel_payload';
  }
  return 'collector_unknown';
}

async function ensureHealthSchema(env) {
  if (healthSchemaReady) return;
  await env.DB.prepare(BUDDY_HEALTH_SCHEMA_SQL).run();
  healthSchemaReady = true;
}

async function currentHealth(env, collectorId) {
  await ensureHealthSchema(env);
  return env.DB.prepare(`SELECT last_success_at,tracks
    FROM sh_collector_status WHERE collector_id=? LIMIT 1`)
    .bind(collectorId)
    .first();
}

async function writeHealth(env, values) {
  await ensureHealthSchema(env);
  await env.DB.prepare(`INSERT INTO sh_collector_status (
      collector_id,status,last_attempt_at,last_success_at,last_error,
      failure_code,failure_stage,failure_summary,failure_hint,tracks,changed,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(collector_id) DO UPDATE SET
      status=excluded.status,
      last_attempt_at=excluded.last_attempt_at,
      last_success_at=COALESCE(excluded.last_success_at,sh_collector_status.last_success_at),
      last_error=excluded.last_error,
      failure_code=excluded.failure_code,
      failure_stage=excluded.failure_stage,
      failure_summary=excluded.failure_summary,
      failure_hint=excluded.failure_hint,
      tracks=COALESCE(excluded.tracks,sh_collector_status.tracks),
      changed=excluded.changed,
      updated_at=excluded.updated_at`)
    .bind(
      values.collectorId,
      values.status,
      values.lastAttemptAt,
      values.lastSuccessAt,
      values.lastError,
      values.failureCode,
      values.failureStage,
      values.failureSummary,
      values.failureHint,
      values.tracks,
      values.changed == null ? null : values.changed ? 1 : 0,
      values.lastAttemptAt,
    )
    .run();
}

export async function recordBuddySuccess(env, alias, result = {}, at = Date.now()) {
  if (!env?.DB) return false;
  await writeHealth(env, {
    collectorId: buddyHealthId(alias),
    status: 'ok',
    lastAttemptAt: at,
    lastSuccessAt: at,
    lastError: null,
    failureCode: null,
    failureStage: null,
    failureSummary: null,
    failureHint: null,
    tracks: nullableNumber(result?.tracks),
    changed: result?.changed === true,
  });
  return true;
}

export async function recordBuddyFailure(env, alias, error, at = Date.now()) {
  if (!env?.DB) return false;
  const collectorId = buddyHealthId(alias);
  const current = await currentHealth(env, collectorId).catch(() => null);
  const diagnosis = diagnoseCollectorFailure(error, failureStage(error), at);
  await writeHealth(env, {
    collectorId,
    status: 'error',
    lastAttemptAt: at,
    lastSuccessAt: nullableNumber(current?.last_success_at),
    lastError: sanitizeFailureDetail(error?.message || error),
    failureCode: diagnosis.code,
    failureStage: diagnosis.stage,
    failureSummary: diagnosis.summary,
    failureHint: diagnosis.hint,
    tracks: nullableNumber(current?.tracks),
    changed: null,
  });
  return true;
}

export function resetBuddyHealthForTests() {
  healthSchemaReady = false;
}
