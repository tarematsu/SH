const ALERT_ID = 'stationhead-collector';
const DEFAULT_STALE_MS = 60 * 60 * 1000;
const MIN_STALE_MS = 5 * 60 * 1000;
const DEFAULT_RESEND_TIMEOUT_MS = 10_000;
const MIN_RESEND_TIMEOUT_MS = 1_000;
const MAX_RESEND_TIMEOUT_MS = 30_000;
const DEFAULT_FROM = 'Stationhead Monitor <onboarding@resend.dev>';

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  return String(value || '').trim();
}

function enabledFlag(value) {
  return Number(value || 0) === 1;
}

export function healthAlertConfig(env = {}) {
  const configuredStaleMs = finite(env.HEALTH_ALERT_STALE_MS);
  const configuredTimeoutMs = finite(env.HEALTH_ALERT_RESEND_TIMEOUT_MS);
  const staleMs = Math.max(MIN_STALE_MS, configuredStaleMs ?? DEFAULT_STALE_MS);
  const resendTimeoutMs = Math.min(
    MAX_RESEND_TIMEOUT_MS,
    Math.max(MIN_RESEND_TIMEOUT_MS, configuredTimeoutMs ?? DEFAULT_RESEND_TIMEOUT_MS),
  );
  const to = text(env.HEALTH_ALERT_TO);
  const from = text(env.HEALTH_ALERT_FROM) || DEFAULT_FROM;
  const apiKey = text(env.RESEND_API_KEY);
  return {
    staleMs,
    resendTimeoutMs,
    to,
    from,
    apiKey,
    enabled: Boolean(apiKey && to),
  };
}

export function evaluateCollectorHealth(state, now = Date.now(), staleMs = DEFAULT_STALE_MS) {
  const lastRunAt = finite(state?.last_run_at);
  const lastSuccessAt = finite(state?.last_success_at);
  const pendingStartedAt = finite(state?.incident_started_at);
  const referenceAt = lastSuccessAt ?? pendingStartedAt;
  const ageMs = referenceAt == null ? null : Math.max(0, now - referenceAt);
  return {
    lastRunAt,
    lastSuccessAt,
    lastError: state?.last_error || null,
    referenceAt,
    ageMs,
    stale: ageMs != null && ageMs >= staleMs,
  };
}

export function hasCollectorRecovered(state, health) {
  const lastSuccessAt = finite(health?.lastSuccessAt ?? state?.last_success_at);
  const baseline = finite(state?.last_observed_success_at)
    ?? finite(state?.incident_started_at)
    ?? finite(state?.last_alert_at);
  return lastSuccessAt != null && baseline != null && lastSuccessAt > baseline;
}

async function loadCollectorOnly(env) {
  const row = await env.DB.prepare(`SELECT last_run_at,last_success_at,last_error
    FROM sh_worker_collector_state WHERE id='stationhead'`).first();
  return {
    ...row,
    alert_table_ready: false,
    delivery_table_ready: false,
  };
}

async function loadAlertWithoutDelivery(env) {
  const row = await env.DB.prepare(`SELECT
      collector.last_run_at,collector.last_success_at,collector.last_error,
      alert.id AS alert_id,alert.incident_open,alert.incident_started_at,
      alert.last_alert_at,alert.last_recovery_at,alert.last_observed_success_at,
      alert.last_error AS alert_last_error,alert.updated_at AS alert_updated_at
    FROM (SELECT ? AS id) requested
    LEFT JOIN sh_worker_collector_state collector ON collector.id='stationhead'
    LEFT JOIN sh_health_alert_state alert ON alert.id=requested.id`)
    .bind(ALERT_ID).first();
  return {
    ...row,
    alert_table_ready: true,
    delivery_table_ready: false,
  };
}

async function loadState(env) {
  try {
    const row = await env.DB.prepare(`SELECT
        collector.last_run_at,collector.last_success_at,collector.last_error,
        alert.id AS alert_id,alert.incident_open,alert.incident_started_at,
        alert.last_alert_at,alert.last_recovery_at,alert.last_observed_success_at,
        alert.last_error AS alert_last_error,alert.updated_at AS alert_updated_at,
        delivery.event_kind AS pending_event_kind,
        delivery.incident_started_at AS pending_incident_started_at,
        delivery.observed_at AS pending_observed_at,
        delivery.baseline_success_at AS pending_baseline_success_at,
        delivery.stale_ms AS pending_stale_ms,
        delivery.subject AS pending_subject,delivery.body AS pending_body,
        delivery.from_address AS pending_from_address,
        delivery.to_address AS pending_to_address,
        delivery.idempotency_key AS pending_idempotency_key,
        delivery.last_attempt_at AS pending_last_attempt_at,
        delivery.last_error AS pending_last_error
      FROM (SELECT ? AS id) requested
      LEFT JOIN sh_worker_collector_state collector ON collector.id='stationhead'
      LEFT JOIN sh_health_alert_state alert ON alert.id=requested.id
      LEFT JOIN sh_health_alert_delivery delivery ON delivery.id=requested.id`)
      .bind(ALERT_ID).first();
    return { ...row, alert_table_ready: true, delivery_table_ready: true };
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
    try {
      return await loadAlertWithoutDelivery(env);
    } catch (fallbackError) {
      if (!/no such table/i.test(String(fallbackError?.message || ''))) throw fallbackError;
      return loadCollectorOnly(env);
    }
  }
}

export async function getCollectorHealthView(env, now = Date.now()) {
  if (!env.DB) return { collector_health_ok: false, collector_health_setup_required: true };
  const cfg = healthAlertConfig(env);
  const state = await loadState(env);
  const health = evaluateCollectorHealth(state, now, cfg.staleMs);
  const incidentOpen = enabledFlag(state.incident_open);
  const recoveryPending = incidentOpen && hasCollectorRecovered(state, health);
  const collectorOk = health.referenceAt != null
    && !health.stale
    && (!incidentOpen || recoveryPending);
  return {
    collector_health_ok: collectorOk,
    collector_health_stale: health.stale,
    collector_health_age_ms: health.ageMs,
    collector_health_stale_after_ms: cfg.staleMs,
    collector_last_run_at: health.lastRunAt,
    collector_last_success_at: health.lastSuccessAt,
    collector_last_error_present: Boolean(health.lastError),
    health_alert_configured: cfg.enabled,
    health_alert_incident_open: incidentOpen,
    health_alert_recovery_pending: recoveryPending,
    health_alert_delivery_pending: text(state.pending_event_kind) || null,
    health_alert_last_sent_at: finite(state.last_alert_at),
    health_alert_last_recovery_at: finite(state.last_recovery_at),
    health_alert_last_error_present: Boolean(state.alert_last_error || state.pending_last_error),
    health_alert_setup_required: !state.alert_table_ready || !state.delivery_table_ready,
  };
}
