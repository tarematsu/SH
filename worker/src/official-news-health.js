import { jsonResponse } from './shared.js';
import { OFFICIAL_NEWS_STATE_ID, finite } from './official-news-utils.js';

export const OFFICIAL_HEALTH_SQL = `SELECT
  monitor.last_check_at,monitor.last_success_at,monitor.last_error,
  (SELECT COUNT(*) FROM sh_official_news_announcements
    WHERE status='scheduled' AND scheduled_at>=?) AS upcoming_count,
  (SELECT COUNT(*) FROM sh_official_news_announcements
    WHERE status='active') AS active_count
FROM (SELECT ? AS id) requested
LEFT JOIN sh_official_news_monitor_state monitor ON monitor.id=requested.id`;

export async function loadOfficialHealthState(env, now = Date.now()) {
  return env.DB.prepare(OFFICIAL_HEALTH_SQL).bind(now, OFFICIAL_NEWS_STATE_ID).first();
}

export async function officialNewsHealth(env, baseResponse) {
  const base = await baseResponse.json().catch(() => ({}));
  try {
    const state = await loadOfficialHealthState(env);
    return jsonResponse({
      ...base,
      official_news_last_check_at: finite(state?.last_check_at),
      official_news_last_success_at: finite(state?.last_success_at),
      official_news_last_error: state?.last_error || null,
      official_news_upcoming_count: Number(state?.upcoming_count || 0),
      official_news_active_count: Number(state?.active_count || 0),
    }, baseResponse.status);
  } catch {
    return jsonResponse({ ...base, official_news_setup_required: true }, baseResponse.status);
  }
}
