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

let schemaReady = false;

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

async function ensureInboxColumns(db) {
  const result = await db.prepare('PRAGMA table_info(sh_minute_fact_jobs)').all();
  const columns = new Set((result.results || []).map((row) => String(row.name)));
  if (!columns.has('job_kind')) {
    await db.prepare("ALTER TABLE sh_minute_fact_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'live'").run();
  }
  if (!columns.has('job_priority')) {
    await db.prepare('ALTER TABLE sh_minute_fact_jobs ADD COLUMN job_priority INTEGER NOT NULL DEFAULT 100').run();
  }
}

export async function ensureMinuteFactInboxSchema(env) {
  if (!env?.FACTS_DB) throw new Error('minute fact inbox DB binding is missing');
  if (schemaReady) return false;
  await env.FACTS_DB.prepare(MINUTE_FACT_INBOX_SCHEMA_SQL).run();
  await ensureInboxColumns(env.FACTS_DB);
  await env.FACTS_DB.prepare('DROP INDEX IF EXISTS idx_sh_minute_fact_jobs_pending').run();
  await env.FACTS_DB.prepare(MINUTE_FACT_INBOX_INDEX_SQL).run();
  schemaReady = true;
  return true;
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
  const result = await env.FACTS_DB.prepare(`INSERT INTO sh_minute_fact_jobs(
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
  await env.FACTS_DB.prepare(`UPDATE sh_minute_fact_jobs SET
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

  const candidates = await env.FACTS_DB.prepare(`SELECT id FROM sh_minute_fact_jobs
    WHERE status='pending' AND next_attempt_at<=?
    ORDER BY job_priority DESC,minute_at ASC,id ASC LIMIT ?`)
    .bind(now, limit)
    .all();

  const claimed = [];
  for (const candidate of candidates.results || []) {
    const id = integer(candidate?.id);
    if (id == null) continue;
    const result = await env.FACTS_DB.prepare(`UPDATE sh_minute_fact_jobs SET
        status='processing',attempts=attempts+1,lease_until=?,updated_at=?
      WHERE id=? AND status='pending' AND next_attempt_at<=?`)
      .bind(now + leaseMs, now, id, now)
      .run();
    if (Number(result?.meta?.changes || 0) <= 0) continue;
    const row = await env.FACTS_DB.prepare('SELECT * FROM sh_minute_fact_jobs WHERE id=?')
      .bind(id)
      .first();
    if (row) claimed.push(row);
  }
  return claimed;
}

export async function completeMinuteFactJob(env, jobId, now = Date.now()) {
  await env.FACTS_DB.prepare(`UPDATE sh_minute_fact_jobs SET
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
  await env.FACTS_DB.prepare(`UPDATE sh_minute_fact_jobs SET
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
  const candidates = await env.FACTS_DB.prepare(`SELECT id FROM sh_minute_fact_jobs
    WHERE status='dead' ORDER BY updated_at ASC,id ASC LIMIT ?`).bind(limit).all();
  const ids = (candidates.results || []).map((row) => integer(row.id)).filter((id) => id != null);
  if (!ids.length) return { requeued: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const result = await env.FACTS_DB.prepare(`UPDATE sh_minute_fact_jobs SET
      status='pending',attempts=0,next_attempt_at=0,lease_until=NULL,last_error=NULL,updated_at=?
    WHERE status='dead' AND id IN (${placeholders})`).bind(now, ...ids).run();
  return { requeued: Number(result?.meta?.changes || 0) };
}

export async function minuteFactInboxStats(env) {
  await ensureMinuteFactInboxSchema(env);
  const row = await env.FACTS_DB.prepare(`SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS processing_count,
      SUM(CASE WHEN status='dead' THEN 1 ELSE 0 END) AS dead_count,
      SUM(CASE WHEN status='pending' AND job_kind='rebuild' THEN 1 ELSE 0 END) AS rebuild_pending_count,
      SUM(CASE WHEN status='pending' AND job_kind='live' THEN 1 ELSE 0 END) AS live_pending_count,
      MIN(CASE WHEN status='pending' THEN minute_at ELSE NULL END) AS oldest_pending_minute
    FROM sh_minute_fact_jobs`).first();
  return {
    pending_count: Number(row?.pending_count || 0),
    processing_count: Number(row?.processing_count || 0),
    dead_count: Number(row?.dead_count || 0),
    rebuild_pending_count: Number(row?.rebuild_pending_count || 0),
    live_pending_count: Number(row?.live_pending_count || 0),
    oldest_pending_minute: row?.oldest_pending_minute == null ? null : Number(row.oldest_pending_minute),
  };
}

export function resetMinuteFactInboxForTests() {
  schemaReady = false;
}
