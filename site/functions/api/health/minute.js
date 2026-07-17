const ACTIVE_TASKS = Object.freeze(['derive', 'recovery', 'rebuild', 'sync']);
const DEFAULT_PENDING_STALE_MS = 15 * 60_000;
const DEFAULT_DERIVE_STALE_MS = 6 * 60_000;
const DEFAULT_MAINTENANCE_STALE_MS = 20 * 60_000;

const SQL = `SELECT
  task_name,last_started_at,last_success_at,last_failure_at,last_duration_ms,
  last_error,runs_total,succeeded_total,failed_total,processed_total,
  job_failures_total,last_processed_count,last_failed_count,pending_count,
  processing_count,dead_count,oldest_pending_minute,updated_at
FROM sh_minute_fact_runtime_state
WHERE task_name IN ('derive','recovery','rebuild','sync')
ORDER BY task_name`;

function integer(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function positiveMs(value, fallback) {
  const parsed = integer(value);
  return parsed != null && parsed > 0 ? parsed : fallback;
}

function nonNegative(value) {
  return Math.max(0, integer(value, 0));
}

function taskStaleMs(taskName, env) {
  return taskName === 'derive'
    ? positiveMs(env.MINUTE_DERIVE_STALE_MS, DEFAULT_DERIVE_STALE_MS)
    : positiveMs(env.MINUTE_MAINTENANCE_STALE_MS, DEFAULT_MAINTENANCE_STALE_MS);
}

export function minuteTaskHealth(row, now, env = {}) {
  const lastStartedAt = integer(row?.last_started_at);
  const lastSuccessAt = integer(row?.last_success_at);
  const lastFailureAt = integer(row?.last_failure_at, 0);
  const oldestPendingMinute = integer(row?.oldest_pending_minute);
  const pendingCount = nonNegative(row?.pending_count);
  const deadCount = nonNegative(row?.dead_count);
  const ageMs = lastStartedAt == null ? null : Math.max(0, now - lastStartedAt);
  const staleAfterMs = taskStaleMs(row?.task_name, env);
  const pendingStaleMs = positiveMs(env.MINUTE_FACT_PENDING_ALERT_MS, DEFAULT_PENDING_STALE_MS);
  const stale = ageMs == null || ageMs >= staleAfterMs;
  const pendingStale = pendingCount > 0
    && oldestPendingMinute != null
    && oldestPendingMinute > 0
    && oldestPendingMinute <= now - pendingStaleMs;
  const lastRunFailed = lastFailureAt > (lastSuccessAt || 0);
  return {
    task_name: String(row?.task_name || ''),
    ok: !stale && deadCount === 0 && !pendingStale && !lastRunFailed,
    stale,
    stale_after_ms: staleAfterMs,
    age_ms: ageMs,
    last_started_at: lastStartedAt,
    last_success_at: lastSuccessAt,
    last_failure_at: integer(row?.last_failure_at),
    last_duration_ms: nonNegative(row?.last_duration_ms),
    last_error_present: Boolean(row?.last_error),
    runs_total: nonNegative(row?.runs_total),
    succeeded_total: nonNegative(row?.succeeded_total),
    failed_total: nonNegative(row?.failed_total),
    processed_total: nonNegative(row?.processed_total),
    job_failures_total: nonNegative(row?.job_failures_total),
    last_processed_count: nonNegative(row?.last_processed_count),
    last_failed_count: nonNegative(row?.last_failed_count),
    pending_count: pendingCount,
    processing_count: nonNegative(row?.processing_count),
    dead_count: deadCount,
    oldest_pending_minute: oldestPendingMinute,
    pending_stale: pendingStale,
    last_run_failed: lastRunFailed,
    updated_at: integer(row?.updated_at),
  };
}

export async function readMinuteHealth(env, now = Date.now()) {
  if (!env?.MINUTE_DB?.prepare) throw new Error('MINUTE_DB binding missing');
  const result = await env.MINUTE_DB.prepare(SQL).all();
  const rows = result?.results || [];
  const byName = new Map(rows.map((row) => [String(row.task_name), row]));
  const tasks = ACTIVE_TASKS.map((taskName) => {
    const row = byName.get(taskName);
    return row
      ? minuteTaskHealth(row, now, env)
      : { task_name: taskName, ok: false, setup_required: true, stale: true };
  });
  return {
    ok: tasks.every((task) => task.ok),
    service: 'sh-minute-pipeline',
    gateway: 'cloudflare-pages',
    checked_at: now,
    tasks,
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
    const payload = await readMinuteHealth(context.env, now);
    return Response.json(payload, {
      status: payload.ok ? 200 : 503,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'pages_minute_health_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
    return Response.json({
      ok: false,
      service: 'sh-minute-pipeline',
      gateway: 'cloudflare-pages',
      error: 'minute-health-query-failed',
      checked_at: now,
      tasks: [],
    }, {
      status: 503,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  }
}
