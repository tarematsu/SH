const OTHER_CRON_ID = 'other-cron';

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

async function readTask(db) {
  return db.prepare(`SELECT status,last_attempt_at,last_success_at,last_error
    FROM sh_collector_status WHERE collector_id=? LIMIT 1`).bind(OTHER_CRON_ID).first();
}

export async function readOtherHealth(env, now = Date.now()) {
  if (!env?.OTHER_DB?.prepare) throw new Error('OTHER_DB binding missing');
  const row = await readTask(env.OTHER_DB);
  const staleAfterMs = positiveMs(env.OTHER_CRON_STALE_MS, 45 * 60_000, 30 * 60_000);
  const ageMs = age(now, row?.last_attempt_at);
  const stale = ageMs == null || ageMs >= staleAfterMs;
  const failed = Boolean(row) && row.status !== 'ok';
  const runtime = {
    ok: Boolean(row) && !stale && !failed,
    setup_required: !row,
    stale,
    stale_after_ms: staleAfterMs,
    age_ms: ageMs,
    last_attempt_at: integer(row?.last_attempt_at),
    last_success_at: integer(row?.last_success_at),
    last_error_present: Boolean(row?.last_error),
    status: row?.status || null,
  };
  return {
    ok: runtime.ok,
    services: ['sh-runtime-orchestrator'],
    gateway: 'cloudflare-pages',
    checked_at: now,
    components: { runtime },
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
      services: ['sh-runtime-orchestrator'],
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
