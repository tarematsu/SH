const OFFICIAL_NEWS_DUE_SQL = `SELECT 1 AS due FROM sh_official_news_announcements
  WHERE scheduled_at IS NOT NULL AND (
    (status='scheduled' AND scheduled_at>=? AND scheduled_at<=?) OR status='active'
  ) LIMIT 1`;

function positiveMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function scheduledTimestamp(controller, fallback = Date.now()) {
  const value = Number(controller?.scheduledTime);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function officialNewsProbeDue(env, now = Date.now()) {
  if (!env?.OTHER_DB?.prepare) return false;
  const earlyMs = positiveMs(env.OFFICIAL_NEWS_EARLY_WINDOW_MS, 10 * 60_000);
  const lateMs = positiveMs(env.OFFICIAL_NEWS_LATE_WINDOW_MS, 90 * 60_000);
  try {
    const row = await env.OTHER_DB.prepare(OFFICIAL_NEWS_DUE_SQL)
      .bind(now - lateMs, now + earlyMs)
      .first();
    return Boolean(row?.due);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'official_news_due_check_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return false;
  }
}

export async function runOfficialNewsWithReconcile(env, now, probe = null, reconcile = null) {
  const activeProbe = probe || (await import('./official-news-probe.js')).runOfficialNewsMonitor;
  const activeReconcile = reconcile || (await import('./official-news-reconcile.js')).reconcileOfficialAnnouncements;
  const { officialNewsConfig } = await import('./official-news-utils.js');
  const probeEnv = probe ? Object.create(env || null) : env;
  const result = await activeProbe(probeEnv, officialNewsConfig(env), now);
  await activeReconcile(env, now);
  return result;
}
