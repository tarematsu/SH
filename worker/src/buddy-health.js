import { diagnoseCollectorFailure, sanitizeFailureDetail } from './collector-failure.js';

export const BUDDY_HEALTH_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_collector_heartbeats (
  collector_id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  hostname TEXT,
  version TEXT,
  metadata_json TEXT
)`;

const VERSION = 'buddy-playback-v1';
let healthSchemaReady = false;

export function buddyHealthId(alias = 'buddy46') {
  return `${String(alias || 'buddy46').trim().toLowerCase()}-playback`;
}

function safeJson(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function failureStage(error) {
  const detail = String(error?.message || error || '');
  if (/401|403|auth|token|session|guest login|guest verification/i.test(detail)) {
    return 'stationhead_auth';
  }
  if (/D1|SQLITE|database|no such table|no such column/i.test(detail)) {
    return 'd1_write_queue';
  }
  if (/queue|payload|response|alias|current_station/i.test(detail)) {
    return 'stationhead_channel_payload';
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
  return env.DB.prepare(`SELECT first_seen_at,last_seen_at,metadata_json
    FROM sh_collector_heartbeats WHERE collector_id=? LIMIT 1`)
    .bind(collectorId)
    .first();
}

async function writeHealth(env, collectorId, at, metadata) {
  await ensureHealthSchema(env);
  await env.DB.prepare(`INSERT INTO sh_collector_heartbeats (
      collector_id,first_seen_at,last_seen_at,hostname,version,metadata_json
    ) VALUES (?,?,?,?,?,?)
    ON CONFLICT(collector_id) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,
      version=excluded.version,
      metadata_json=excluded.metadata_json`)
    .bind(collectorId, at, at, null, VERSION, JSON.stringify(metadata))
    .run();
}

export async function recordBuddySuccess(env, alias, result = {}, at = Date.now()) {
  if (!env?.DB) return false;
  await writeHealth(env, buddyHealthId(alias), at, {
    status: 'ok',
    last_attempt_at: at,
    last_success_at: at,
    last_error: null,
    failure_code: null,
    failure_stage: null,
    failure_summary: null,
    failure_hint: null,
    tracks: Number.isFinite(Number(result?.tracks)) ? Number(result.tracks) : null,
    changed: result?.changed === true,
  });
  return true;
}

export async function recordBuddyFailure(env, alias, error, at = Date.now()) {
  if (!env?.DB) return false;
  const collectorId = buddyHealthId(alias);
  const current = await currentHealth(env, collectorId).catch(() => null);
  const previous = safeJson(current?.metadata_json);
  const diagnosis = diagnoseCollectorFailure(error, failureStage(error), at);
  await writeHealth(env, collectorId, at, {
    status: 'error',
    last_attempt_at: at,
    last_success_at: Number(previous.last_success_at) || null,
    last_error: sanitizeFailureDetail(error?.message || error),
    failure_code: diagnosis.code,
    failure_stage: diagnosis.stage,
    failure_summary: diagnosis.summary,
    failure_hint: diagnosis.hint,
    tracks: Number.isFinite(Number(previous.tracks)) ? Number(previous.tracks) : null,
  });
  return true;
}

export function resetBuddyHealthForTests() {
  healthSchemaReady = false;
}
