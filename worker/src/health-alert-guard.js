const ALERT_ID = 'stationhead-collector';

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function changed(result) {
  return Number(result?.meta?.changes || 0) > 0;
}

export function pendingAlertIsObsolete(row) {
  if (String(row?.event_kind || '') !== 'alert') return false;
  const currentSuccessAt = finite(row?.last_success_at);
  if (currentSuccessAt == null) return false;
  const baselineSuccessAt = finite(row?.baseline_success_at);
  return baselineSuccessAt == null || currentSuccessAt > baselineSuccessAt;
}

function retiredDeliveryId(idempotencyKey, now) {
  let hash = 2166136261;
  for (const character of String(idempotencyKey || '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `retired-${now}-${(hash >>> 0).toString(36)}`;
}

export async function retireRecoveredPendingAlert(env, now = Date.now()) {
  if (!env?.DB) return false;

  let row;
  try {
    row = await env.DB.prepare(`SELECT
        collector.last_success_at,
        delivery.event_kind,
        delivery.incident_started_at,
        delivery.baseline_success_at,
        delivery.idempotency_key
      FROM sh_health_alert_delivery delivery
      LEFT JOIN sh_worker_collector_state collector ON collector.id='stationhead'
      WHERE delivery.id=?`)
      .bind(ALERT_ID).first();
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return false;
    throw error;
  }

  if (!pendingAlertIsObsolete(row)) return false;

  const incidentStartedAt = finite(row.incident_started_at)
    ?? finite(row.baseline_success_at)
    ?? now;
  const retiredId = retiredDeliveryId(row.idempotency_key, now);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE sh_health_alert_state SET
        incident_open=1,
        incident_started_at=?,
        last_observed_success_at=?,
        last_error=NULL,
        updated_at=?
      WHERE id=? AND EXISTS (
        SELECT 1 FROM sh_health_alert_delivery
        WHERE id=? AND idempotency_key=? AND event_kind='alert'
      )`)
      .bind(
        incidentStartedAt,
        finite(row.baseline_success_at),
        now,
        ALERT_ID,
        ALERT_ID,
        row.idempotency_key,
      ),
    env.DB.prepare(`UPDATE sh_health_alert_delivery SET
        id=?,last_error='retired_after_recovery',updated_at=?
      WHERE id=? AND idempotency_key=? AND event_kind='alert'`)
      .bind(retiredId, now, ALERT_ID, row.idempotency_key),
  ]);

  const stateUpdated = changed(results?.[0]);
  const deliveryRetired = changed(results?.[1]);
  if (!stateUpdated || !deliveryRetired) {
    console.warn(JSON.stringify({
      event: 'collector_health_alert_retire_skipped',
      reason: 'stale_or_partial_update',
      state_updated: stateUpdated,
      delivery_retired: deliveryRetired,
    }));
    return false;
  }

  console.log(JSON.stringify({
    event: 'collector_health_alert_retired_after_recovery',
    incident_started_at: incidentStartedAt,
    baseline_success_at: finite(row.baseline_success_at),
    current_success_at: finite(row.last_success_at),
  }));
  return true;
}
