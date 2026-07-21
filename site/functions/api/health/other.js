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

async function readSakurazaka(db, id) {
  return db.prepare(`SELECT phase,session_id,station_id,last_success_at,last_error,updated_at
    FROM sh_cloud_host_monitor_state WHERE id=? LIMIT 1`).bind(id).first();
}

export async function readOtherHealth(env, now = Date.now()) {
  if (!env?.OTHER_DB?.prepare) throw new Error('OTHER_DB binding missing');
  const soloId = `solo:${String(env.SOLO_BROADCAST_HANDLE || 'sakurazaka46jp').trim().toLowerCase()}`;
  const results = await Promise.allSettled([
    readTask(env.OTHER_DB, OTHER_CRON_ID),
    readOfficial(env.OTHER_DB, now),
    readSakurazaka(env.OTHER_DB, soloId),
  ]);
  const [cronResult, officialResult, sakurazakaResult] = results;
  const cronRow = cronResult.status === 'fulfilled' ? cronResult.value : null;
  const official = officialResult.status === 'fulfilled' ? officialResult.value : null;
  const sakurazakaRow = sakurazakaResult.status === 'fulfilled' ? sakurazakaResult.value : null;

  const cronStaleMs = positiveMs(env.OTHER_CRON_STALE_MS, 45 * 60_000, 30 * 60_000);
  const officialStaleMs = positiveMs(env.OFFICIAL_NEWS_STALE_MS, 2 * 60 * 60_000, 30 * 60_000);
  const sakurazakaStaleMs = positiveMs(env.CLOUD_HOST_STALE_MS, 2 * 60 * 60_000, 30 * 60_000);

  const prediction = taskHealth(cronRow, now, cronStaleMs, cronResult.status === 'rejected');

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

  const sakurazakaReference = integer(sakurazakaRow?.updated_at)
    ?? integer(sakurazakaRow?.last_success_at);
  const sakurazakaAgeMs = age(now, sakurazakaReference);
  const sakurazakaSetupRequired = sakurazakaResult.status === 'rejected' || !sakurazakaRow;
  const sakurazakaStale = sakurazakaAgeMs == null || sakurazakaAgeMs >= sakurazakaStaleMs;
  const sakurazaka = {
    ok: !sakurazakaSetupRequired && !sakurazakaStale && !sakurazakaRow?.last_error,
    setup_required: sakurazakaSetupRequired,
    stale: sakurazakaStale,
    stale_after_ms: sakurazakaStaleMs,
    age_ms: sakurazakaAgeMs,
    phase: sakurazakaRow?.phase || 'idle',
    session_id: integer(sakurazakaRow?.session_id),
    station_id: integer(sakurazakaRow?.station_id),
    last_success_at: integer(sakurazakaRow?.last_success_at),
    last_error_present: Boolean(sakurazakaRow?.last_error),
  };

  const components = { prediction, official_news: officialNews, sakurazaka };
  return {
    ok: Object.values(components).every((component) => component.ok),
    services: ['sh-runtime-orchestrator', 'sh-sakurazaka46jp'],
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
      services: ['sh-runtime-orchestrator', 'sh-sakurazaka46jp'],
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
