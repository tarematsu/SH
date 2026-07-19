const CACHE_MS = 5 * 60 * 1000;
const DEFAULT_STALE_MS = 60 * 60 * 1000;
const MIN_STALE_MS = 5 * 60 * 1000;
const snapshotCountCache = { value: null, expiresAt: 0, pending: null };

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function enabledFlag(value) {
  return Number(value || 0) === 1;
}

export function healthStaleMs(env = {}) {
  return Math.max(MIN_STALE_MS, finite(env.HEALTH_ALERT_STALE_MS) ?? DEFAULT_STALE_MS);
}

export async function cachedSnapshotCount(db, now = Date.now()) {
  if (snapshotCountCache.value != null && snapshotCountCache.expiresAt > now) {
    return snapshotCountCache.value;
  }
  // Health only needs a monotonic high-water estimate. COUNT(*) scans the complete
  // facts table on D1, while MAX(id) uses the INTEGER PRIMARY KEY b-tree.
  const row = await db.prepare('SELECT COALESCE(MAX(id),0) AS count FROM sh_minute_facts').first();
  const value = Number(row?.count || 0);
  snapshotCountCache.value = value;
  snapshotCountCache.expiresAt = Date.now() + CACHE_MS;
  return value;
}

export function resetSnapshotCountCache() {
  snapshotCountCache.value = null;
  snapshotCountCache.expiresAt = 0;
  snapshotCountCache.pending = null;
}

async function loadCollectorOnly(db) {
  const row = await db.prepare(`SELECT last_run_at,last_success_at,last_error
    FROM sh_worker_collector_state WHERE id='stationhead'`).first();
  return {
    ...row,
    alert_setup_required: true,
    delivery_setup_required: true,
  };
}

async function loadAlertWithoutDelivery(db) {
  const row = await db.prepare(`SELECT
      collector.last_run_at,collector.last_success_at,collector.last_error,
      alert.incident_open,alert.incident_started_at,alert.last_alert_at,
      alert.last_recovery_at,alert.last_observed_success_at,
      alert.last_error AS alert_last_error,alert.updated_at AS alert_updated_at
    FROM (SELECT 'stationhead-collector' AS id) requested
    LEFT JOIN sh_worker_collector_state collector ON collector.id='stationhead'
    LEFT JOIN sh_health_alert_state alert ON alert.id=requested.id`).first();
  return {
    ...row,
    alert_setup_required: false,
    delivery_setup_required: true,
  };
}

async function loadCollectorState(db) {
  const row = await db.prepare(`SELECT last_run_at,last_success_at,last_error_present,updated_at
    FROM sh_collector_read_model WHERE collector_id='cloudflare-worker' LIMIT 1`).first();
  return {
    ...row,
    last_error: row?.last_error_present ? 'present' : null,
    alert_setup_required: false,
    delivery_setup_required: false,
  };
}

export function publicCollectorHealth(state, now, staleAfterMs) {
  const lastRunAt = finite(state?.last_run_at);
  const lastSuccessAt = finite(state?.last_success_at);
  const incidentStartedAt = finite(state?.incident_started_at);
  const lastObservedSuccessAt = finite(state?.last_observed_success_at);
  const lastAlertAt = finite(state?.last_alert_at);
  const referenceAt = lastSuccessAt ?? incidentStartedAt;
  const ageMs = referenceAt == null ? null : Math.max(0, now - referenceAt);
  const stale = ageMs != null && ageMs >= staleAfterMs;
  const incidentOpen = enabledFlag(state?.incident_open);
  const recoveryBaseline = lastObservedSuccessAt ?? incidentStartedAt ?? lastAlertAt;
  const recoveryPending = incidentOpen
    && lastSuccessAt != null
    && recoveryBaseline != null
    && lastSuccessAt > recoveryBaseline;
  const healthy = referenceAt != null
    && !stale
    && (!incidentOpen || recoveryPending);
  return {
    lastRunAt,
    lastSuccessAt,
    incidentStartedAt,
    ageMs,
    stale,
    incidentOpen,
    recoveryPending,
    healthy,
  };
}

export async function onRequestGet(context) {
  const now = Date.now();
  try {
    if (!context.env.MINUTE_DB) throw new Error('MINUTE_DB binding missing');
    const [snapshotCount, state] = await Promise.all([
      cachedSnapshotCount(context.env.MINUTE_DB, now),
      loadCollectorState(context.env.MINUTE_DB),
    ]);
    const staleAfterMs = healthStaleMs(context.env);
    const health = publicCollectorHealth(state, now, staleAfterMs);
    return Response.json({
      ok: health.healthy,
      service: 'sh-monitor',
      snapshotCount,
      time: new Date(now).toISOString(),
      collector_last_run_at: health.lastRunAt,
      collector_last_success_at: health.lastSuccessAt,
      collector_age_ms: health.ageMs,
      collector_stale_after_ms: staleAfterMs,
      collector_stale: health.stale,
      collector_last_error_present: Boolean(state?.last_error),
      alert_setup_required: Boolean(state?.alert_setup_required || state?.delivery_setup_required),
      alert_incident_open: health.incidentOpen,
      alert_recovery_pending: health.recoveryPending,
      alert_delivery_pending: String(state?.pending_event_kind || '').trim() || null,
      alert_incident_started_at: health.incidentStartedAt,
      alert_last_sent_at: finite(state?.last_alert_at),
      alert_last_recovery_at: finite(state?.last_recovery_at),
      alert_last_error_present: Boolean(state?.alert_last_error || state?.pending_last_error),
      checked_at: now,
    }, {
      status: health.healthy ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'public_health_check_failed',
      error: String(error?.message || error),
    }));
    return Response.json({
      ok: false,
      service: 'sh-monitor',
      error: 'health_check_failed',
      checked_at: now,
    }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
