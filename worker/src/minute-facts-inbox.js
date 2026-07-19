import { sanitizeFailureDetail } from './collector-failure.js';
import { minuteBucket } from './minute-facts-store.js';

export const MINUTE_FACT_INBOX_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_minute_fact_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  minute_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  job_kind TEXT NOT NULL DEFAULT 'live',
  job_priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  processed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel_id, minute_at)
)`;

export const MINUTE_FACT_INBOX_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_jobs_pending
  ON sh_minute_fact_jobs(status, job_priority DESC, next_attempt_at, minute_at)`;

export const REQUEUE_DEAD_MINUTE_FACT_JOBS_SQL = `UPDATE sh_minute_fact_jobs SET
    status='pending',attempts=0,next_attempt_at=0,lease_until=NULL,last_error=NULL,updated_at=?
  WHERE id IN (
    SELECT jobs.id FROM sh_minute_fact_jobs jobs
    WHERE jobs.status='dead'
      AND NOT EXISTS (
        SELECT 1 FROM sh_minute_facts facts
        WHERE facts.channel_id=jobs.channel_id AND facts.minute_at=jobs.minute_at
      )
      AND COALESCE(jobs.last_error,'') NOT LIKE 'invalid minute fact job payload:%'
      AND COALESCE(jobs.last_error,'') NOT LIKE 'unsupported minute fact payload version:%'
    ORDER BY jobs.updated_at ASC,jobs.id ASC LIMIT ?
  ) AND status='dead'
  RETURNING id`;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function text(value, fallback = null) {
  const parsed = String(value ?? '').trim();
  return parsed || fallback;
}

export function minuteFactJobPayload(input = {}) {
  return {
    payload_version: 1,
    observedAt: integer(input.observedAt) ?? Date.now(),
    snapshot: input.snapshot || {},
    queue: input.queue || null,
    comments: input.comments || {},
    rebuild: input.rebuild || null,
  };
}

export async function ensureMinuteFactInboxSchema(env) {
  if (!env?.MINUTE_DB) throw new Error('minute fact inbox DB binding is missing');
  // Owned by database/facts-migrations/012_minute_runtime_tables.sql.
  return false;
}

export async function enqueueMinuteFactJob(env, input = {}, options = {}) {
  await ensureMinuteFactInboxSchema(env);
  const payload = minuteFactJobPayload(input);
  const channelId = integer(payload.snapshot?.channel_id);
  if (channelId == null) throw new Error('minute fact job requires channel_id');
  const observedAt = integer(payload.observedAt) ?? Date.now();
  const minuteAt = minuteBucket(observedAt);
  const now = Date.now();
  const jobKind = text(options.jobKind, payload.rebuild ? 'rebuild' : 'live');
  const jobPriority = positiveInteger(options.jobPriority, payload.rebuild ? 20 : 100, 1000);
  const requeueCompleted = options.requeueCompleted === true ? 1 : 0;
  const result = await env.MINUTE_DB.prepare(`INSERT INTO sh_minute_fact_jobs(
      channel_id,minute_at,observed_at,payload_version,payload_json,job_kind,job_priority,
      status,attempts,next_attempt_at,lease_until,processed_at,last_error,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,'pending',0,0,NULL,NULL,NULL,?,?)
    ON CONFLICT(channel_id,minute_at) DO UPDATE SET
      observed_at=excluded.observed_at,payload_version=excluded.payload_version,
      payload_json=excluded.payload_json,job_kind=excluded.job_kind,
      job_priority=excluded.job_priority,status='pending',attempts=0,next_attempt_at=0,
      lease_until=NULL,processed_at=NULL,last_error=NULL,updated_at=excluded.updated_at
    WHERE ?=1 AND sh_minute_fact_jobs.status IN ('done','dead')`)
    .bind(
      channelId,
      minuteAt,
      observedAt,
      payload.payload_version,
      JSON.stringify(payload),
      jobKind,
      jobPriority,
      now,
      now,
      requeueCompleted,
    )
    .run();
  return {
    enqueued: Number(result?.meta?.changes || 0) > 0,
    channel_id: channelId,
    minute_at: minuteAt,
    job_kind: jobKind,
    job_priority: jobPriority,
  };
}

async function releaseExpiredLeases(env, now) {
  await env.MINUTE_DB.prepare(`UPDATE sh_minute_fact_jobs SET
      status='pending',lease_until=NULL,updated_at=?
    WHERE status='processing' AND COALESCE(lease_until,0)<?`)
    .bind(now, now)
    .run();
}

export async function claimMinuteFactJobs(env, options = {}) {
  await ensureMinuteFactInboxSchema(env);
  const now = integer(options.now) ?? Date.now();
  const limit = positiveInteger(options.limit, 1, 20);
  const leaseMs = positiveInteger(options.leaseMs, 60_000, 10 * 60_000);
  await releaseExpiredLeases(env, now);

  const claimed = await env.MINUTE_DB.prepare(`UPDATE sh_minute_fact_jobs SET
      status='processing',attempts=attempts+1,lease_until=?,updated_at=?
    WHERE id IN (
      SELECT id FROM sh_minute_fact_jobs
      WHERE status='pending' AND next_attempt_at<=?
      ORDER BY job_priority DESC,minute_at ASC,id ASC
      LIMIT ?
    )
    RETURNING *`)
    .bind(now + leaseMs, now, now, limit)
    .all();
  return claimed.results || [];
}

export async function releaseMinuteFactJobs(env, jobIds, options = {}) {
  const ids = (Array.isArray(jobIds) ? jobIds : [])
    .map((id) => integer(id))
    .filter((id) => id != null);
  if (!ids.length) return { released: 0 };
  const now = integer(options.now) ?? Date.now();
  const placeholders = ids.map(() => '?').join(',');
  const result = await env.MINUTE_DB.prepare(`UPDATE sh_minute_fact_jobs SET
      status='pending',attempts=MAX(0,attempts-1),next_attempt_at=0,lease_until=NULL,updated_at=?
    WHERE status='processing' AND id IN (${placeholders})`)
    .bind(now, ...ids)
    .run();
  return { released: Number(result?.meta?.changes || 0) };
}

export async function completeMinuteFactJob(env, jobId, now = Date.now()) {
  await env.MINUTE_DB.prepare(`UPDATE sh_minute_fact_jobs SET
      status='done',lease_until=NULL,processed_at=?,last_error=NULL,updated_at=?
    WHERE id=? AND status='processing'`)
    .bind(now, now, jobId)
    .run();
}

export async function failMinuteFactJob(env, job, error, options = {}) {
  const now = integer(options.now) ?? Date.now();
  const maxAttempts = positiveInteger(options.maxAttempts, 8, 100);
  const attempts = positiveInteger(job?.attempts, 1, 1000);
  const terminal = attempts >= maxAttempts;
  const retryDelayMs = positiveInteger(options.retryDelayMs, 60_000, 60 * 60_000);
  const message = sanitizeFailureDetail(error?.message || error).slice(0, 800);
  await env.MINUTE_DB.prepare(`UPDATE sh_minute_fact_jobs SET
      status=?,next_attempt_at=?,lease_until=NULL,last_error=?,updated_at=?
    WHERE id=? AND status='processing'`)
    .bind(
      terminal ? 'dead' : 'pending',
      terminal ? 0 : now + retryDelayMs,
      message,
      now,
      job.id,
    )
    .run();
  return { terminal, attempts };
}

export async function requeueDeadMinuteFactJobs(env, options = {}) {
  await ensureMinuteFactInboxSchema(env);
  const limit = positiveInteger(options.limit, 20, 100);
  const now = integer(options.now) ?? Date.now();
  const result = await env.MINUTE_DB.prepare(REQUEUE_DEAD_MINUTE_FACT_JOBS_SQL)
    .bind(now, limit)
    .all();
  return { requeued: result.results?.length || 0 };
}

export async function minuteFactInboxStats(env) {
  await ensureMinuteFactInboxSchema(env);
  const row = await env.MINUTE_DB.prepare(`SELECT
      (SELECT COUNT(*) FROM sh_minute_fact_jobs WHERE status='pending') AS pending_count,
      (SELECT COUNT(*) FROM sh_minute_fact_jobs WHERE status='processing') AS processing_count,
      (SELECT COUNT(*) FROM sh_minute_fact_jobs WHERE status='dead') AS dead_count,
      (SELECT COUNT(*) FROM sh_minute_fact_jobs WHERE status='pending' AND job_kind='rebuild') AS rebuild_pending_count,
      (SELECT COUNT(*) FROM sh_minute_fact_jobs WHERE status='pending' AND job_kind='live') AS live_pending_count,
      (SELECT MIN(minute_at) FROM sh_minute_fact_jobs WHERE status='pending') AS oldest_pending_minute`).first();
  return {
    pending_count: Number(row?.pending_count || 0),
    processing_count: Number(row?.processing_count || 0),
    dead_count: Number(row?.dead_count || 0),
    rebuild_pending_count: Number(row?.rebuild_pending_count || 0),
    live_pending_count: Number(row?.live_pending_count || 0),
    oldest_pending_minute: row?.oldest_pending_minute == null ? null : Number(row.oldest_pending_minute),
  };
}

export function resetMinuteFactInboxForTests() {}
