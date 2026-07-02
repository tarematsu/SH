const CACHE_MS = 5 * 60 * 1000;
const DEFAULT_STALE_MS = 60 * 60 * 1000;
const snapshotCountCache = { value: null, expiresAt: 0, pending: null };

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function cachedSnapshotCount(db, now = Date.now()) {
  if (snapshotCountCache.value != null && snapshotCountCache.expiresAt > now) {
    return snapshotCountCache.value;
  }
  if (!snapshotCountCache.pending) {
    snapshotCountCache.pending = db.prepare('SELECT COUNT(*) AS count FROM sh_channel_snapshots').first()
      .then((row) => {
        const value = Number(row?.count || 0);
        snapshotCountCache.value = value;
        snapshotCountCache.expiresAt = Date.now() + CACHE_MS;
        return value;
      })
      .finally(() => { snapshotCountCache.pending = null; });
  }
  return snapshotCountCache.pending;
}

export function resetSnapshotCountCache() {
  snapshotCountCache.value = null;
  snapshotCountCache.expiresAt = 0;
  snapshotCountCache.pending = null;
}

async function loadCollectorState(db) {
  try {
    const row = await db.prepare(`SELECT
        collector.last_run_at,collector.last_success_at,collector.last_error,
        alert.incident_open,alert.incident_started_at,alert.last_alert_at,
        alert.last_recovery_at,alert.last_error AS alert_last_error
      FROM (SELECT 'stationhead-collector' AS id) requested
      LEFT JOIN sh_worker_collector_state collector ON collector.id='stationhead'
      LEFT JOIN sh_health_alert_state alert ON alert.id=requested.id`).first();
    return { ...row, alert_setup_required: false };
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
    const row = await db.prepare(`SELECT last_run_at,last_success_at,last_error
      FROM sh_worker_collector_state WHERE id='stationhead'`).first();
    return { ...row, alert_setup_required: true };
  }
}

export async function onRequestGet(context) {
  const now = Date.now();
  try {
    const [snapshotCount, state] = await Promise.all([
      cachedSnapshotCount(context.env.DB, now),
      loadCollectorState(context.env.DB),
    ]);
    const lastRunAt = finite(state?.last_run_at);
    const lastSuccessAt = finite(state?.last_success_at);
    const pendingStartedAt = finite(state?.incident_started_at);
    const referenceAt = lastSuccessAt ?? pendingStartedAt;
    const ageMs = referenceAt == null ? null : Math.max(0, now - referenceAt);
    const stale = ageMs != null && ageMs >= DEFAULT_STALE_MS;
    const healthy = referenceAt != null && !stale;
    return Response.json({
      ok: healthy,
      service: 'stationhead-monitor',
      snapshotCount,
      time: new Date(now).toISOString(),
      collector_last_run_at: lastRunAt,
      collector_last_success_at: lastSuccessAt,
      collector_age_ms: ageMs,
      collector_stale_after_ms: DEFAULT_STALE_MS,
      collector_stale: stale,
      collector_last_error_present: Boolean(state?.last_error),
      alert_setup_required: Boolean(state?.alert_setup_required),
      alert_incident_open: Boolean(state?.incident_open),
      alert_incident_started_at: pendingStartedAt,
      alert_last_sent_at: finite(state?.last_alert_at),
      alert_last_recovery_at: finite(state?.last_recovery_at),
      alert_last_error_present: Boolean(state?.alert_last_error),
      checked_at: now,
    }, {
      status: healthy ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'public_health_check_failed',
      error: String(error?.message || error),
    }));
    return Response.json({
      ok: false,
      service: 'stationhead-monitor',
      error: 'health_check_failed',
      checked_at: now,
    }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
