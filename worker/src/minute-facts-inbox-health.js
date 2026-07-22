import { ensureMinuteFactInboxSchema } from './minute-facts-inbox.js';

export const MINUTE_FACT_INBOX_HEALTH_SQL = `SELECT
    pending.pending_count,
    processing.processing_count,
    dead.dead_count,
    pending.rebuild_pending_count,
    pending.live_pending_count,
    pending.oldest_pending_minute
  FROM (
    SELECT
      COUNT(*) AS pending_count,
      COUNT(*) FILTER (WHERE job_kind='rebuild') AS rebuild_pending_count,
      COUNT(*) FILTER (WHERE job_kind='live') AS live_pending_count,
      MIN(minute_at) AS oldest_pending_minute
    FROM sh_minute_fact_jobs
    WHERE status='pending'
  ) pending
  CROSS JOIN (
    SELECT COUNT(*) AS processing_count
    FROM sh_minute_fact_jobs
    WHERE status='processing'
  ) processing
  CROSS JOIN (
    SELECT COUNT(*) AS dead_count
    FROM sh_minute_fact_jobs
    WHERE status='dead'
  ) dead`;

export async function minuteFactInboxHealth(env) {
  await ensureMinuteFactInboxSchema(env);
  const row = await env.MINUTE_DB.prepare(MINUTE_FACT_INBOX_HEALTH_SQL).first();
  return {
    pending_count: Number(row?.pending_count || 0),
    processing_count: Number(row?.processing_count || 0),
    dead_count: Number(row?.dead_count || 0),
    rebuild_pending_count: Number(row?.rebuild_pending_count || 0),
    live_pending_count: Number(row?.live_pending_count || 0),
    oldest_pending_minute: row?.oldest_pending_minute == null ? null : Number(row.oldest_pending_minute),
  };
}
