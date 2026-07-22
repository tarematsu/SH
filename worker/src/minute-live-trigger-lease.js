function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export async function claimBudgetedLiveDeriveJob(env, trigger, options = {}) {
  const db = env?.MINUTE_DB;
  if (!db?.prepare) throw new Error('minute live derive MINUTE_DB binding is missing');
  const now = integer(options.now) ?? Date.now();
  const leaseMs = positiveInteger(options.leaseMs, 60_000, 10 * 60_000);
  const jobKind = String(trigger?.job_kind || 'live');
  const result = await db.prepare(`UPDATE sh_minute_fact_jobs SET
      status='processing',attempts=attempts+1,lease_until=?,updated_at=?
    WHERE channel_id=? AND minute_at=? AND job_kind=? AND (
      (status='pending' AND next_attempt_at<=?)
      OR (status='processing' AND COALESCE(lease_until,0)<?)
    )
    RETURNING *`)
    .bind(
      now + leaseMs,
      now,
      integer(trigger?.channel_id),
      integer(trigger?.minute_at),
      jobKind,
      now,
      now,
    )
    .all();
  return result.results?.[0] || null;
}

export async function releaseBudgetedLiveDeriveJob(env, jobId, options = {}) {
  const id = integer(jobId);
  if (id == null || id <= 0) return { released: 0 };
  const db = env?.MINUTE_DB;
  if (!db?.prepare) throw new Error('minute live derive MINUTE_DB binding is missing');
  const now = integer(options.now) ?? Date.now();
  const result = await db.prepare(`UPDATE sh_minute_fact_jobs SET
      status='pending',attempts=MAX(0,attempts-1),next_attempt_at=0,
      lease_until=NULL,updated_at=?
    WHERE status='processing' AND id=?`)
    .bind(now, id)
    .run();
  return { released: Number(result?.meta?.changes || 0) };
}
