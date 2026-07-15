const OTHER_CRON_ID = 'other-cron';
const OFFICIAL_NEWS_ID = 'official-news';

function integer(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function positiveMs(value, fallback, minimum = 1_000) {
  const parsed = integer(value);
  return parsed != null && parsed > 0 ? Math.max(minimum, parsed) : fallback;
}

function enabled(value, fallback = true) {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function age(now, value) {
  const timestamp = integer(value);
  return timestamp == null ? null : Math.max(0, now - timestamp);
}

function taskHealth(row, now, staleAfterMs, setupRequired = false) {
  const ageMs = age(now, row?.last_attempt_at);
  const stale = ageMs == null || ageMs >= staleAfterMs;
  const failed = Boolean(row) && row.status !== 'ok';
  return {
    ok: !setupRequired && !stale && !failed,
    setup_required: setupRequired || !row,
    stale,
    stale_after_ms: staleAfterMs,
    age_ms: ageMs,
    last_attempt_at: integer(row?.last_attempt_at),
    last_success_at: integer(row?.last_success_at),
    last_error_present: Boolean(row?.last_error),
    status: row?.status || null,
  };
}

async function readTask(db, collectorId) {
  return db.prepare(`SELECT status,last_attempt_at,last_success_at,last_error
    FROM sh_collector_status WHERE collector_id=? LIMIT 1`).bind(collectorId).first();
}

async function readOfficial(db, now) {
  return db.prepare(`SELECT
      monitor.last_check_at,monitor.last_success_at,monitor.last_error,
      (SELECT COUNT(*) FROM sh_official_news_announcements
        WHERE status='scheduled' AND scheduled_at>=?) AS upcoming_count,
      (SELECT COUNT(*) FROM sh_official_news_announcements
        WHERE status='active') AS active_count
    FROM (SELECT ? AS id) requested
    LEFT JOIN sh_official_news_monitor_state monitor ON monitor.id=requested.id`)
    .bind(now, OFFICIAL_NEWS_ID)
    .first();
}

async function readHost(db, id) {
  return db.prepare(`SELECT phase,session_id,station_id,last_success_at,last_error,updated_at
    FROM sh_cloud_host_monitor_state WHERE id=? LIMIT 1`).bind(id).first();
}

export async function readOtherHealth(env, now = Date.now()) {
  if (!env?.OTHER_DB?.prepare) throw new Error('OTHER_DB binding missing');
  const buddyEnabled = enabled(env.BUDDY_PLAYBACK_ENABLED, true);
  const buddyAlias = String(env.BUDDY_PLAYBACK_ALIAS || 'buddy46').trim().toLowerCase();
  const profileId = `profile:${String(env.HOST_PROFILE_HANDLE || 'sakuramankai').trim().toLowerCase()}`;
  const soloId = `solo:${String(env.SOLO_BROADCAST_HANDLE || 'sakurazaka46jp').trim().toLowerCase()}`;
  const results = await Promise.allSettled([
    readTask(env.OTHER_DB, OTHER_CRON_ID),
    buddyEnabled ? readTask(env.OTHER_DB, `${buddyAlias}-playback`) : Promise.resolve(null),
    readOfficial(env.OTHER_DB, now),
    readHost(env.OTHER_DB, profileId),
    readHost(env.OTHER_DB, soloId),
  ]);
  const [cronResult, buddyResult, officialResult, profileResult, soloResult] = results;
  const cronRow = cronResult.status === 'fulfilled' ? cronResult.value : null;
  const buddyRow = buddyResult.status === 'fulfilled' ? buddyResult.value : null;
  const official = officialResult.status === 'fulfilled' ? officialResult.value : null;
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : null;
  const solo = soloResult.status === 'fulfilled' ? soloResult.value : null;

  const cronStaleMs = positiveMs(env.OTHER_CRON_STALE_MS, 12 * 60_000, 5 * 60_000);
  const buddyIntervalMs = positiveMs(env.BUDDY_PLAYBACK_INTERVAL_MS, 3 * 60 * 60_000, 5 * 60_000);
  const buddyStaleMs = positiveMs(env.BUDDY_PLAYBACK_STALE_MS, buddyIntervalMs + 15 * 60_000, buddyIntervalMs);
  const officialStaleMs = positiveMs(env.OFFICIAL_NEWS_STALE_MS, 2 * 60 * 60_000, 30 * 60_000);
  const hostStaleMs = positiveMs(env.CLOUD_HOST_STALE_MS, 2 * 60 * 60_000, 30 * 60_000);

  const cron = taskHealth(cronRow, now, cronStaleMs, cronResult.status === 'rejected');
  const buddy = buddyEnabled
    ? taskHealth(buddyRow, now, buddyStaleMs, buddyResult.status === 'rejected')
    : { ok: true, enabled: false, setup_required: false, stale: false };

  const officialAgeMs = age(now, official?.last_check_at);
  const officialSetupRequired = officialResult.status === 'rejected' || integer(official?.last_check_at) == null;
  const officialStale = officialAgeMs == null || officialAgeMs >= officialStaleMs;
  const officialNews = {
    ok: !officialSetupRequired && !officialStale && !official?.last_error,
    setup_required: officialSetupRequired,
    stale: officialStale,
    stale_after_ms: officialStaleMs,
    age_ms: officialAgeMs,
    last_check_at: integer(official?.last_check_at),
    last_success_at: integer(official?.last_success_at),
    last_error_present: Boolean(official?.last_error),
    upcoming_count: Number(official?.upcoming_count || 0),
    active_count: Number(official?.active_count || 0),
  };

  const profileReference = integer(profile?.updated_at) ?? integer(profile?.last_success_at);
  const profileAgeMs = age(now, profileReference);
  const hostSetupRequired = profileResult.status === 'rejected' || !profile;
  const hostStale = profileAgeMs == null || profileAgeMs >= hostStaleMs;
  const cloudHost = {
    ok: !hostSetupRequired && !hostStale && !profile?.last_error && !solo?.last_error,
    setup_required: hostSetupRequired,
    stale: hostStale,
    stale_after_ms: hostStaleMs,
    age_ms: profileAgeMs,
    profile_phase: profile?.phase || null,
    profile_last_success_at: integer(profile?.last_success_at),
    profile_last_error_present: Boolean(profile?.last_error),
    solo_phase: solo?.phase || 'idle',
    solo_session_id: integer(solo?.session_id),
    solo_station_id: integer(solo?.station_id),
    solo_last_error_present: Boolean(solo?.last_error),
  };

  const components = { cron, buddy, official_news: officialNews, cloud_host: cloudHost };
  return {
    ok: Object.values(components).every((component) => component.ok),
    service: 'sh-monitor-other',
    gateway: 'cloudflare-pages',
    checked_at: now,
    components,
  };
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return Response.json({ ok: false, error: 'method-not-allowed' }, {
      status: 405,
      headers: { allow: 'GET' },
    });
  }
  const now = Date.now();
  try {
    const payload = await readOtherHealth(context.env, now);
    return Response.json(payload, {
      status: payload.ok ? 200 : 503,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'pages_other_health_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return Response.json({
      ok: false,
      service: 'sh-monitor-other',
      gateway: 'cloudflare-pages',
      error: 'other-health-query-failed',
      checked_at: now,
      components: {},
    }, {
      status: 503,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  }
}
