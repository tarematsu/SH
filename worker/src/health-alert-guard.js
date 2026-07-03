const ALERT_ID = 'stationhead-collector';

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function changed(result) {
  return Number(result?.meta?.changes || 0) > 0;
}

function hasText(value) {
  return String(value ?? '').trim() !== '';
}

export function pendingAlertIsObsolete(row) {
  if (String(row?.event_kind || '') !== 'alert') return false;
  const currentSuccessAt = finite(row?.last_success_at);
  if (currentSuccessAt == null) return false;
  const baselineSuccessAt = finite(row?.baseline_success_at);
  return baselineSuccessAt == null || currentSuccessAt > baselineSuccessAt;
}

export function shouldReprepareAfterFalseRecoveryCancel(cancelled, prepared) {
  return Boolean(
    cancelled
      && prepared?.diagnosis
      && prepared?.pending == null
      && !prepared?.incidentOpen
  );
}

function retiredDeliveryId(idempotencyKey, now) {
  let hash = 2166136261;
  for (const character of String(idempotencyKey || '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `retired-${now}-${(hash >>> 0).toString(36)}`;
}

async function restorePendingAlertDelivery(env, row, retiredId, now) {
  const result = await env.DB.prepare(`UPDATE sh_health_alert_delivery SET
      id=?,last_error=?,updated_at=?
    WHERE id=? AND idempotency_key=? AND event_kind='alert' AND last_error='retired_after_recovery'`)
    .bind(
      ALERT_ID,
      row.delivery_last_error ?? null,
      finite(row.delivery_updated_at) ?? now,
      retiredId,
      row.idempotency_key,
    ).run();
  return changed(result);
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
        delivery.idempotency_key,
        delivery.last_error AS delivery_last_error,
        delivery.updated_at AS delivery_updated_at
      FROM sh_health_alert_delivery delivery
      LEFT JOIN sh_worker_collector_state collector ON collector.id='stationhead'
      WHERE delivery.id=?`)
      .bind(ALERT_ID).first();
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return false;
    throw error;
  }

  if (!pendingAlertIsObsolete(row)) return false;
  if (!hasText(row?.idempotency_key)) {
    console.warn(JSON.stringify({
      event: 'collector_health_alert_retire_skipped',
      reason: 'missing_idempotency_key',
      state_updated: false,
      delivery_retired: false,
      delivery_restored: false,
    }));
    return false;
  }

  const currentSuccessAt = finite(row.last_success_at);
  const baselineSuccessAt = finite(row.baseline_success_at);
  const observedSuccessAt = baselineSuccessAt ?? currentSuccessAt;
  const incidentStartedAt = finite(row.incident_started_at)
    ?? baselineSuccessAt
    ?? currentSuccessAt
    ?? now;
  const retiredId = retiredDeliveryId(row.idempotency_key, now);
  const retireResult = await env.DB.prepare(`UPDATE sh_health_alert_delivery SET
      id=?,last_error='retired_after_recovery',updated_at=?
    WHERE id=? AND idempotency_key=? AND event_kind='alert'`)
    .bind(retiredId, now, ALERT_ID, row.idempotency_key).run();

  const deliveryRetired = changed(retireResult);
  if (!deliveryRetired) {
    console.warn(JSON.stringify({
      event: 'collector_health_alert_retire_skipped',
      reason: 'stale_delivery_update',
      state_updated: false,
      delivery_retired: false,
      delivery_restored: false,
    }));
    return false;
  }

  const stateResult = await env.DB.prepare(`UPDATE sh_health_alert_state SET
      incident_open=1,
      incident_started_at=?,
      last_observed_success_at=?,
      last_error=NULL,
      updated_at=?
    WHERE id=? AND incident_open=0 AND EXISTS (
      SELECT 1 FROM sh_health_alert_delivery
      WHERE id=? AND idempotency_key=? AND event_kind='alert' AND last_error='retired_after_recovery'
    )`)
    .bind(
      incidentStartedAt,
      observedSuccessAt,
      now,
      ALERT_ID,
      retiredId,
      row.idempotency_key,
    ).run();

  const stateUpdated = changed(stateResult);
  if (!stateUpdated) {
    const deliveryRestored = await restorePendingAlertDelivery(env, row, retiredId, now).catch((error) => {
      console.warn(JSON.stringify({
        event: 'collector_health_alert_retire_restore_failed',
        error: String(error?.message || error),
      }));
      return false;
    });
    console.warn(JSON.stringify({
      event: 'collector_health_alert_retire_skipped',
      reason: 'stale_state_update',
      state_updated: false,
      delivery_retired: true,
      delivery_restored: deliveryRestored,
    }));
    return false;
  }

  console.log(JSON.stringify({
    event: 'collector_health_alert_retired_after_recovery',
    incident_started_at: incidentStartedAt,
    baseline_success_at: baselineSuccessAt,
    observed_success_at: observedSuccessAt,
    current_success_at: currentSuccessAt,
  }));
  return true;
}
