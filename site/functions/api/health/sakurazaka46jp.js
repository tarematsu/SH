const OFFICIAL_NEWS_ID = 'official-news';

function integer(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function positiveMs(value, fallback, minimum = 1_000) {
  const parsed = integer(value);
  return parsed != null && parsed > 0 ? Math.max(minimum, parsed) : fallback;
}

function age(now, value) {
  const timestamp = integer(value);
  return timestamp == null ? null : Math.max(0, now - timestamp);
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

async function readMonitor(db, id) {
  return db.prepare(`SELECT phase,session_id,station_id,last_success_at,last_error,updated_at
    FROM sh_cloud_host_monitor_state WHERE id=? LIMIT 1`).bind(id).first();
}

export async function readSakurazakaHealth(env, now = Date.now()) {
  if (!env?.OTHER_DB?.prepare) throw new Error('OTHER_DB binding missing');
  const monitorId = `solo:${String(env.SOLO_BROADCAST_HANDLE || 'sakurazaka46jp').trim().toLowerCase()}`;
  const [officialResult, monitorResult] = await Promise.allSettled([
    readOfficial(env.OTHER_DB, now),
    readMonitor(env.OTHER_DB, monitorId),
  ]);
  const official = officialResult.status === 'fulfilled' ? officialResult.value : null;
  const monitor = monitorResult.status === 'fulfilled' ? monitorResult.value : null;

  const officialStaleMs = positiveMs(env.OFFICIAL_NEWS_STALE_MS, 2 * 60 * 60_000, 30 * 60_000);
  const monitorStaleMs = positiveMs(env.CLOUD_HOST_STALE_MS, 2 * 60 * 60_000, 30 * 60_000);

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

  const monitorReference = integer(monitor?.updated_at) ?? integer(monitor?.last_success_at);
  const monitorAgeMs = age(now, monitorReference);
  const monitorSetupRequired = monitorResult.status === 'rejected' || !monitor;
  const monitorStale = monitorAgeMs == null || monitorAgeMs >= monitorStaleMs;
  const soloMonitor = {
    ok: !monitorSetupRequired && !monitorStale && !monitor?.last_error,
    setup_required: monitorSetupRequired,
    stale: monitorStale,
    stale_after_ms: monitorStaleMs,
    age_ms: monitorAgeMs,
    phase: monitor?.phase || 'idle',
    session_id: integer(monitor?.session_id),
    station_id: integer(monitor?.station_id),
    last_success_at: integer(monitor?.last_success_at),
    last_error_present: Boolean(monitor?.last_error),
  };

  const components = { official_news: officialNews, solo_monitor: soloMonitor };
  return {
    ok: Object.values(components).every((component) => component.ok),
    services: ['sh-sakurazaka46jp'],
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
    const payload = await readSakurazakaHealth(context.env, now);
    return Response.json(payload, {
      status: payload.ok ? 200 : 503,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'pages_sakurazaka_health_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return Response.json({
      ok: false,
      services: ['sh-sakurazaka46jp'],
      gateway: 'cloudflare-pages',
      error: 'sakurazaka-health-query-failed',
      checked_at: now,
      components: {},
    }, {
      status: 503,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  }
}
