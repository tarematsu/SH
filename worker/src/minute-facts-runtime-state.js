import { sanitizeFailureDetail } from './collector-failure.js';

// This is deliberately separate from the inbox: the inbox describes individual
// jobs, while this table makes the health of each scheduled task cheap to inspect.
export const MINUTE_FACT_RUNTIME_STATE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_minute_fact_runtime_state (
  task_name TEXT PRIMARY KEY,
  last_started_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_duration_ms INTEGER,
  last_error TEXT,
  runs_total INTEGER NOT NULL DEFAULT 0,
  succeeded_total INTEGER NOT NULL DEFAULT 0,
  failed_total INTEGER NOT NULL DEFAULT 0,
  processed_total INTEGER NOT NULL DEFAULT 0,
  job_failures_total INTEGER NOT NULL DEFAULT 0,
  last_processed_count INTEGER NOT NULL DEFAULT 0,
  last_failed_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  processing_count INTEGER NOT NULL DEFAULT 0,
  dead_count INTEGER NOT NULL DEFAULT 0,
  oldest_pending_minute INTEGER,
  updated_at INTEGER NOT NULL
)`;

let schemaReady = false;

function finiteInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, finiteInteger(value, fallback));
}

function taskName(value) {
  const name = String(value ?? '').trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(name)) throw new Error('minute fact runtime task name is invalid');
  return name;
}

function successFor(outcome, options) {
  if (typeof options.success === 'boolean') return options.success;
  return outcome?.ok !== false && !outcome?.error;
}

export function minuteFactRuntimeSnapshot(outcome = {}) {
  return {
    processed_count: nonNegativeInteger(outcome.processed),
    failed_count: nonNegativeInteger(outcome.failed),
    pending_count: nonNegativeInteger(outcome.pending_count),
    processing_count: nonNegativeInteger(outcome.processing_count),
    dead_count: nonNegativeInteger(outcome.dead_count),
    oldest_pending_minute: finiteInteger(outcome.oldest_pending_minute),
  };
}

export async function ensureMinuteFactRuntimeStateSchema(env) {
  if (!env?.MINUTE_DB) throw new Error('minute fact runtime state DB binding is missing');
  if (schemaReady) return false;
  await env.MINUTE_DB.prepare(MINUTE_FACT_RUNTIME_STATE_SCHEMA_SQL).run();
  schemaReady = true;
  return true;
}

export async function recordMinuteFactRuntimeState(env, task, outcome = {}, options = {}) {
  await ensureMinuteFactRuntimeStateSchema(env);
  const now = finiteInteger(options.now, Date.now());
  const startedAt = finiteInteger(options.startedAt, now);
  const success = successFor(outcome, options);
  const snapshot = minuteFactRuntimeSnapshot(outcome);
  const error = success ? null : sanitizeFailureDetail(outcome?.error?.message || outcome?.error || outcome?.last_error || 'unknown failure').slice(0, 800);
  const name = taskName(task);

  await env.MINUTE_DB.prepare(`INSERT INTO sh_minute_fact_runtime_state(
      task_name,last_started_at,last_success_at,last_failure_at,last_duration_ms,last_error,
      runs_total,succeeded_total,failed_total,processed_total,job_failures_total,
      last_processed_count,last_failed_count,pending_count,processing_count,dead_count,
      oldest_pending_minute,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(task_name) DO UPDATE SET
      last_started_at=excluded.last_started_at,
      last_success_at=CASE WHEN excluded.last_success_at IS NULL THEN sh_minute_fact_runtime_state.last_success_at ELSE excluded.last_success_at END,
      last_failure_at=CASE WHEN excluded.last_failure_at IS NULL THEN sh_minute_fact_runtime_state.last_failure_at ELSE excluded.last_failure_at END,
      last_duration_ms=excluded.last_duration_ms,last_error=excluded.last_error,
      runs_total=sh_minute_fact_runtime_state.runs_total+1,
      succeeded_total=sh_minute_fact_runtime_state.succeeded_total+excluded.succeeded_total,
      failed_total=sh_minute_fact_runtime_state.failed_total+excluded.failed_total,
      processed_total=sh_minute_fact_runtime_state.processed_total+excluded.processed_total,
      job_failures_total=sh_minute_fact_runtime_state.job_failures_total+excluded.job_failures_total,
      last_processed_count=excluded.last_processed_count,last_failed_count=excluded.last_failed_count,
      pending_count=excluded.pending_count,processing_count=excluded.processing_count,
      dead_count=excluded.dead_count,oldest_pending_minute=excluded.oldest_pending_minute,
      updated_at=excluded.updated_at`)
    .bind(
      name, startedAt, success ? now : null, success ? null : now,
      Math.max(0, now - startedAt), error,
      1, success ? 1 : 0, success ? 0 : 1,
      snapshot.processed_count, snapshot.failed_count,
      snapshot.processed_count, snapshot.failed_count, snapshot.pending_count,
      snapshot.processing_count, snapshot.dead_count, snapshot.oldest_pending_minute, now,
    )
    .run();
  return { task_name: name, ok: success, at: now, ...snapshot, error };
}

export async function readMinuteFactRuntimeState(env, task = null) {
  await ensureMinuteFactRuntimeStateSchema(env);
  if (task == null) {
    const result = await env.MINUTE_DB.prepare('SELECT * FROM sh_minute_fact_runtime_state ORDER BY task_name').all();
    return result.results || [];
  }
  return env.MINUTE_DB.prepare('SELECT * FROM sh_minute_fact_runtime_state WHERE task_name=?').bind(taskName(task)).first();
}

export function minuteFactRuntimeSignals(state, options = {}) {
  const now = finiteInteger(options.now, Date.now());
  const pendingAgeMs = nonNegativeInteger(options.pendingAgeMs, 15 * 60_000);
  const oldest = finiteInteger(state?.oldest_pending_minute);
  const pendingBacklog = nonNegativeInteger(state?.pending_count) > 0;
  return {
    has_dead_jobs: nonNegativeInteger(state?.dead_count) > 0,
    pending_backlog: pendingBacklog,
    pending_stale: pendingBacklog && oldest != null && oldest > 0 && oldest <= now - pendingAgeMs,
    last_run_failed: finiteInteger(state?.last_failure_at, 0) > finiteInteger(state?.last_success_at, 0),
  };
}

export function resetMinuteFactRuntimeStateForTests() {
  schemaReady = false;
}
