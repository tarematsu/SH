const DEFAULT_STALE_MS = 60 * 60 * 1000;

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function loadState(db) {
  try {
    return await db.prepare(`SELECT
        collector.last_run_at,collector.last_success_at,collector.last_error,
        alert.incident_open,alert.incident_started_at,alert.last_alert_at,
        alert.last_recovery_at,alert.last_error AS alert_last_error
      FROM (SELECT 'stationhead-collector' AS id) requested
      LEFT JOIN sh_worker_collector_state collector ON collector.id='stationhead'
      LEFT JOIN sh_health_alert_state alert ON alert.id=requested.id`).first();
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
    return db.prepare(`SELECT last_run_at,last_success_at,last_error
      FROM sh_worker_collector_state WHERE id='stationhead'`).first();
  }
}

export async function onRequestGet(context) {
  const now = Date.now();
  try {
    const state = await loadState(context.env.DB);
    const lastRunAt = finite(state?.last_run_at);
    const lastSuccessAt = finite(state?.last_success_at);
    const referenceAt = lastSuccessAt ?? lastRunAt;
    const ageMs = referenceAt == null ? null : Math.max(0, now - referenceAt);
    const stale = ageMs == null || ageMs >= DEFAULT_STALE_MS;
    return Response.json({
      ok: !stale,
      service: 'stationhead-monitor',
      collector_last_run_at: lastRunAt,
      collector_last_success_at: lastSuccessAt,
      collector_age_ms: ageMs,
      collector_stale_after_ms: DEFAULT_STALE_MS,
      collector_stale: stale,
      collector_last_error: state?.last_error || null,
      alert_incident_open: Boolean(state?.incident_open),
      alert_incident_started_at: finite(state?.incident_started_at),
      alert_last_sent_at: finite(state?.last_alert_at),
      alert_last_recovery_at: finite(state?.last_recovery_at),
      alert_last_error: state?.alert_last_error || null,
      checked_at: now,
    }, {
      status: stale ? 503 : 200,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return Response.json({
      ok: false,
      service: 'stationhead-monitor',
      error: String(error?.message || error),
      checked_at: now,
    }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
