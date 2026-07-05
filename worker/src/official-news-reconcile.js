export const RECONCILE_SUPERSEDED_ANNOUNCEMENTS_SQL = `UPDATE sh_official_news_announcements AS stale
SET status='superseded',updated_at=?
WHERE stale.status='scheduled'
  AND stale.scheduled_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM sh_official_news_monitor_state AS monitor
    WHERE monitor.id='official-news'
      AND monitor.last_success_at IS NOT NULL
      AND monitor.last_success_at=monitor.last_check_at
      AND monitor.last_check_at>=?
  )
  AND EXISTS (
    SELECT 1
    FROM sh_official_news_announcements AS current
    WHERE current.news_id=stale.news_id
      AND current.id<>stale.id
      AND current.status<>'superseded'
      AND current.updated_at>stale.updated_at
  )`;

export async function reconcileSupersededAnnouncements(
  env,
  runStartedAt = Date.now(),
  completedAt = Date.now(),
) {
  if (!env?.DB) return { changes: 0, skipped: true };
  try {
    const result = await env.DB.prepare(RECONCILE_SUPERSEDED_ANNOUNCEMENTS_SQL)
      .bind(completedAt, runStartedAt)
      .run();
    return {
      changes: Number(result?.meta?.changes || 0),
      skipped: false,
    };
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) {
      return { changes: 0, skipped: true };
    }
    throw error;
  }
}
