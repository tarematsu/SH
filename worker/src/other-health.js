import { readOptimizedHealth } from './optimized-health.js';
import { buddyHealthId, OTHER_CRON_HEALTH_ID } from './buddy-health.js';
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
  'other_cron_last_error',
  'buddy_playback_last_error',
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

function positiveMs(value, fallback, minimum) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(minimum, number) : fallback;
}

function taskHealth(row, now, staleMs) {
  const lastAttemptAt = finite(row?.last_attempt_at);
  const ageMs = lastAttemptAt == null ? null : Math.max(0, now - lastAttemptAt);
  return {
    ok: Boolean(row) && row.status === 'ok' && ageMs != null && ageMs < staleMs,
    ageMs,
    lastAttemptAt,
    lastSuccessAt: finite(row?.last_success_at),
    lastError: row?.last_error || null,
  };
}

async function loadTaskHealth(env, collectorId) {
  return env.OTHER_DB.prepare(`SELECT status,last_attempt_at,last_success_at,last_error
    FROM sh_collector_status WHERE collector_id=? LIMIT 1`).bind(collectorId).first();
}

async function loadOtherHealth(env, now = Date.now()) {
  if (!env?.OTHER_DB?.prepare) {
    return {
      other_health_ok: false,
      official_news_setup_required: true,
      cloud_host_setup_required: true,
    };
  }
  const buddyEnabled = !['0', 'false', 'no', 'off'].includes(
    String(env.BUDDY_PLAYBACK_ENABLED ?? 'true').trim().toLowerCase(),
  );
  const buddyId = buddyHealthId(env.BUDDY_PLAYBACK_ALIAS || 'buddy46');
  const profileHealthId = `profile:${String(env.HOST_PROFILE_HANDLE || 'sakuramankai').trim().toLowerCase()}`;
  const soloHealthId = `solo:${String(env.SOLO_BROADCAST_HANDLE || 'sakurazaka46jp').trim().toLowerCase()}`;
  const [officialResult, profileResult, soloResult, cronResult, buddyResult] = await Promise.allSettled([
    loadOfficialHealthState(env),
    Promise.resolve().then(() => env.OTHER_DB.prepare(`SELECT phase,session_id,station_id,last_success_at,last_error,updated_at
      FROM sh_cloud_host_monitor_state WHERE id=?`).bind(profileHealthId).first()),
    Promise.resolve().then(() => env.OTHER_DB.prepare(`SELECT phase,session_id,station_id,last_success_at,last_error,updated_at
      FROM sh_cloud_host_monitor_state WHERE id=?`).bind(soloHealthId).first()),
    loadTaskHealth(env, OTHER_CRON_HEALTH_ID),
    buddyEnabled ? loadTaskHealth(env, buddyId) : Promise.resolve(null),
  ]);
  const official = officialResult.status === 'fulfilled' ? officialResult.value : null;
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : null;
  const solo = soloResult.status === 'fulfilled' ? soloResult.value : null;
  const officialError = official?.last_error || null;
  const hostError = profile?.last_error || solo?.last_error || null;
  const officialSetupRequired = officialResult.status === 'rejected' || finite(official?.last_check_at) == null;
  const hostSetupRequired = profileResult.status === 'rejected'
    || soloResult.status === 'rejected'
    || !profile;
  const cronRow = cronResult.status === 'fulfilled' ? cronResult.value : null;
  const buddyRow = buddyResult.status === 'fulfilled' ? buddyResult.value : null;
  const cronStaleMs = positiveMs(env.OTHER_CRON_STALE_MS, 3 * 60_000, 2 * 60_000);
  const buddyIntervalMs = positiveMs(env.BUDDY_PLAYBACK_INTERVAL_MS, 3 * 60 * 60_000, 5 * 60_000);
  const buddyStaleMs = positiveMs(env.BUDDY_PLAYBACK_STALE_MS, buddyIntervalMs + 15 * 60_000, buddyIntervalMs);
  const cronHealth = taskHealth(cronRow, now, cronStaleMs);
  const buddyHealth = buddyEnabled
    ? taskHealth(buddyRow, now, buddyStaleMs)
    : { ok: true, ageMs: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null };
  return {
    other_health_ok: !officialSetupRequired
      && !hostSetupRequired
      && !officialError
      && !hostError
      && cronHealth.ok
      && buddyHealth.ok,
    official_news_setup_required: officialSetupRequired,
    cloud_host_setup_required: hostSetupRequired,
    official_news_last_check_at: finite(official?.last_check_at),
    official_news_last_success_at: finite(official?.last_success_at),
    official_news_last_error: officialError,
    official_news_upcoming_count: Number(official?.upcoming_count || 0),
    official_news_active_count: Number(official?.active_count || 0),
    cloud_solo_phase: solo?.phase || 'idle',
    cloud_solo_session_id: finite(solo?.session_id),
    cloud_solo_station_id: finite(solo?.station_id),
    cloud_host_last_success_at: finite(profile?.last_success_at),
    cloud_host_last_error: hostError,
    other_cron_health_ok: cronHealth.ok,
    other_cron_health_age_ms: cronHealth.ageMs,
    other_cron_last_attempt_at: cronHealth.lastAttemptAt,
    other_cron_last_success_at: cronHealth.lastSuccessAt,
    other_cron_last_error: cronHealth.lastError,
    other_cron_setup_required: cronResult.status === 'rejected' || !cronRow,
    buddy_playback_health_ok: buddyHealth.ok,
    buddy_playback_health_age_ms: buddyHealth.ageMs,
    buddy_playback_last_attempt_at: buddyHealth.lastAttemptAt,
    buddy_playback_last_success_at: buddyHealth.lastSuccessAt,
    buddy_playback_last_error: buddyHealth.lastError,
    buddy_playback_setup_required: buddyEnabled && (buddyResult.status === 'rejected' || !buddyRow),
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
