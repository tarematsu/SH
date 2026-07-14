import { readOptimizedHealth } from './optimized-health.js';
import { getCollectorHealthView } from './health-alert.js';
import { loadOfficialHealthState } from './official-news-health.js';
import { finite } from './official-news-utils.js';
import { createPublicHealthCachedApp } from './public-health-cache.js';

const RAW_ERROR_FIELDS = [
  'last_error',
  'auth_last_error',
  'browser_last_auth_error',
  'official_news_last_error',
  'cloud_host_last_error',
];

function sanitizeErrors(payload = {}) {
  const sanitized = { ...payload };
  for (const field of RAW_ERROR_FIELDS) {
    if (!(field in sanitized)) continue;
    sanitized[`${field}_present`] = Boolean(sanitized[field]);
    delete sanitized[field];
  }
  return sanitized;
}

async function loadOtherHealth(env) {
  if (!env?.OTHER_DB?.prepare) {
    return {
      other_health_ok: false,
      official_news_setup_required: true,
      cloud_host_setup_required: true,
    };
  }
  const [officialResult, hostResult] = await Promise.allSettled([
    loadOfficialHealthState(env),
    Promise.resolve().then(() => env.OTHER_DB.prepare(`SELECT phase,session_id,station_id,last_success_at,last_error,updated_at
      FROM sh_cloud_host_monitor_state WHERE id=?`).bind('solo:sakurazaka46jp').first()),
  ]);
  const official = officialResult.status === 'fulfilled' ? officialResult.value : null;
  const host = hostResult.status === 'fulfilled' ? hostResult.value : null;
  const officialError = official?.last_error || null;
  const hostError = host?.last_error || null;
  return {
    other_health_ok: officialResult.status === 'fulfilled'
      && hostResult.status === 'fulfilled'
      && !officialError
      && !hostError,
    official_news_setup_required: officialResult.status === 'rejected',
    cloud_host_setup_required: hostResult.status === 'rejected',
    official_news_last_check_at: finite(official?.last_check_at),
    official_news_last_success_at: finite(official?.last_success_at),
    official_news_last_error: officialError,
    official_news_upcoming_count: Number(official?.upcoming_count || 0),
    official_news_active_count: Number(official?.active_count || 0),
    cloud_solo_phase: host?.phase || null,
    cloud_solo_session_id: finite(host?.session_id),
    cloud_solo_station_id: finite(host?.station_id),
    cloud_host_last_success_at: finite(host?.last_success_at),
    cloud_host_last_error: hostError,
  };
}

const healthApp = {
  scheduled() {},

  async fetch(request, env, ctx) {
    const baseResponse = await readOptimizedHealth(env).catch((error) => {
      console.error(JSON.stringify({
        event: 'other_primary_health_failed',
        error: String(error?.message || error),
      }));
      return Response.json({
        ok: false,
        primary_health_error_present: true,
      }, { status: 503 });
    });
    const base = await baseResponse.json().catch(() => ({}));
    const [collectorHealth, otherHealth] = await Promise.all([
      getCollectorHealthView(env).catch(() => ({
        collector_health_ok: false,
        collector_health_error_present: true,
      })),
      loadOtherHealth(env),
    ]);
    const healthy = baseResponse.ok
      && collectorHealth.collector_health_ok !== false
      && otherHealth.other_health_ok;
    const status = healthy ? baseResponse.status : 503;
    return Response.json(sanitizeErrors({
      ...base,
      ...collectorHealth,
      ...otherHealth,
      ok: healthy,
    }), { status });
  },
};

export function createOtherHealthApp() {
  return createPublicHealthCachedApp(healthApp);
}
