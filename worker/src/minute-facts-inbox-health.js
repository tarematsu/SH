import { minuteFactInboxStats } from './minute-facts-inbox.js';

// Kept for compatibility with diagnostics that identify the retired aggregate
// shape. Runtime health reads must use sh_minute_fact_inbox_stats instead.
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
  return minuteFactInboxStats(env);
}
