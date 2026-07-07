import app from './scheduled-main.js';
import { getCollectorHealthView, runCollectorHealthAlert } from './health-alert.js';
import {
  retireRecoveredPendingAlert,
  shouldReprepareAfterFalseRecoveryCancel,
} from './health-alert-guard.js';
import {
  diagnoseScheduledCollection,
  diagnosticHealthView,
  inspectCollectorState,
  prepareDetailedCollectorAlert,
  sendEmergencyD1Alert,
} from './collector-diagnostics.js';
import {
  diagnosisFromState,
  isD1Failure,
  recordCollectorFailure,
  sanitizeFailureDetail,
} from './collector-failure.js';

const ALERT_ID = 'stationhead-collector';
const RAW_ERROR_FIELDS = [
  'last_error',
  'auth_last_error',
  'browser_last_auth_error',
  'official_news_last_error',
  'cloud_host_last_error',
];

export function sanitizeHealthPayload(payload = {}) {
  const sanitized = { ...payload };
  for (const field of RAW_ERROR_FIELDS) {
    if (!(field in sanitized)) continue;
    sanitized[`${field}_present`] = Boolean(sanitized[field]);
    delete sanitized[field];
  }
  return sanitized;
}

export function healthResponseStatus(baseStatus, collectorHealth) {
  const status = Number.isInteger(baseStatus) && baseStatus >= 100 && baseStatus <= 599
    ? baseStatus
    : 500;
  if (status >= 200 && status < 300 && collectorHealth?.collector_health_ok === false) {
    return 503;
  }
  return status;
}

function changed(result) {
  return Number(result?.meta?.changes || 0) > 0;
}

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function recoveredSinceIncident(state = {}) {
  const lastSuccessAt = finite(state.last_success_at);
  const baseline = finite(state.last_observed_success_at)
    ?? finite(state.incident_started_at)
    ?? finite(state.last_alert_at);
  return lastSuccessAt != null && baseline != null && lastSuccessAt > baseline;
}

async function discardDisabledDeliveries(env) {
  if (!env?.DB) return false;
  try {
    const result = await env.DB.prepare(`DELETE FROM sh_health_alert_delivery
      WHERE id=? AND (
        event_kind='recovery'
        OR (event_kind='alert' AND idempotency_key LIKE 'stationhead-monitor-down-%')
      )`).bind(ALERT_ID).run();
    const deleted = changed(result);
    if (deleted) {
      console.warn(JSON.stringify({
        event: 'collector_disabled_delivery_discarded',
      }));
    }
    return deleted;
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return false;
    throw error;
  }
}

async function closeRecoveredIncidentWithoutEmail(env, prepared, now = Date.now()) {
  if (!env?.DB || !prepared?.incidentOpen || !recoveredSinceIncident(prepared.state)) return false;
  const recoveredAt = finite(prepared.state.last_success_at) ?? now;
  await env.DB.batch([
    env.DB.prepare(`UPDATE sh_health_alert_state SET
        incident_open=0,incident_started_at=NULL,last_recovery_at=?,
        last_observed_success_at=?,last_error=NULL,updated_at=?
      WHERE id=?`)
      .bind(recoveredAt, recoveredAt, now, ALERT_ID),
    env.DB.prepare(`DELETE FROM sh_health_alert_delivery
      WHERE id=? AND event_kind='recovery'`)
      .bind(ALERT_ID),
  ]);
  console.log(JSON.stringify({
    event: 'collector_recovered_without_recovery_email',
    recovered_at: recoveredAt,
  }));
  return true;
}

async function emergencyIfNeeded(env, failure) {
  if (!failure || !isD1Failure(failure.diagnosis || failure)) return;
  await sendEmergencyD1Alert(env, failure).catch((error) => {
    console.error(JSON.stringify({
      event: 'collector_emergency_d1_alert_failed',
      error: sanitizeFailureDetail(error?.message || error),
    }));
  });
}

export async function cancelFalseRecoveryPending(env, prepared) {
  if (!prepared?.diagnosis || !prepared?.incidentOpen || prepared?.pending !== 'recovery' || !env?.DB) {
    return false;
  }

  const result = await env.DB.prepare(`DELETE FROM sh_health_alert_delivery
    WHERE id='stationhead-collector' AND event_kind='recovery'`).run();
  const deleted = changed(result);
  if (deleted) prepared.pending = null;

  console.warn(JSON.stringify({
    event: deleted
      ? 'collector_false_recovery_cancelled'
      : 'collector_false_recovery_cancel_skipped',
    reason: deleted ? 'active_failure_diagnostic' : 'stale_recovery_delivery',
    code: prepared.diagnosis.code,
    stage: prepared.diagnosis.stage,
    delivery_deleted: deleted,
  }));
  return deleted;
}

export async function alignFailureStartWithLastSuccess(env, state, failure = null, now = Date.now()) {
  const lastSuccessAt = Number(state?.last_success_at || 0);
  const failureAt = Number(failure?.diagnosis?.at || state?.failure_last_at || 0);
  if (!env?.DB || !lastSuccessAt || !failureAt || failureAt <= lastSuccessAt) return false;
  const result = await env.DB.prepare(`UPDATE sh_collector_failure_state
    SET first_failure_at=CASE
        WHEN first_failure_at IS NULL OR first_failure_at>? THEN ?
        ELSE first_failure_at
      END,
      updated_at=?
    WHERE id='stationhead' AND last_failure_at>=?`)
    .bind(lastSuccessAt, lastSuccessAt, now, lastSuccessAt).run();
  return Number(result?.meta?.changes || 0) > 0;
}

export default {
  async scheduled(controller, env, ctx) {
    const runStartedAt = Date.now();
    let before = null;
    let appError = null;

    try {
      before = await inspectCollectorState(env);
    } catch (error) {
      await emergencyIfNeeded(env, error);
      console.error(JSON.stringify({
        event: 'collector_diagnostic_preflight_failed',
        error: sanitizeFailureDetail(error?.message || error),
      }));
    }

    try {
      await app.scheduled(controller, env, ctx);
    } catch (error) {
      appError = error;
      console.error(JSON.stringify({
        event: 'collector_scheduled_failed',
        error: sanitizeFailureDetail(error?.message || error),
      }));
    }

    let diagnosticResult = null;
    try {
      diagnosticResult = await diagnoseScheduledCollection(env, before, runStartedAt, appError);
      const priorDiagnosis = before ? diagnosisFromState(before) : null;
      if (
        diagnosticResult?.failure?.diagnosis?.code === 'COLLECTOR_INTERNAL_ERROR'
        && priorDiagnosis
        && priorDiagnosis.code !== 'COLLECTOR_INTERNAL_ERROR'
      ) {
        diagnosticResult.failure = { diagnosis: priorDiagnosis };
        await recordCollectorFailure(
          env,
          diagnosticResult.failure,
          priorDiagnosis.stage,
          'scheduled-guard-preserved',
        ).catch(() => {});
        const originalFirstAt = Number(priorDiagnosis.firstAt || priorDiagnosis.at || 0);
        if (originalFirstAt > 0 && env.DB) {
          await env.DB.prepare(`UPDATE sh_collector_failure_state
            SET first_failure_at=CASE
                WHEN first_failure_at IS NULL OR first_failure_at>? THEN ?
                ELSE first_failure_at
              END,
              updated_at=? WHERE id='stationhead'`)
            .bind(originalFirstAt, originalFirstAt, Date.now()).run().catch(() => {});
        }
      }
      await alignFailureStartWithLastSuccess(
        env,
        diagnosticResult?.state,
        diagnosticResult?.failure,
      ).catch((error) => {
        console.warn(JSON.stringify({
          event: 'collector_failure_start_alignment_failed',
          error: sanitizeFailureDetail(error?.message || error),
        }));
      });
      await emergencyIfNeeded(env, diagnosticResult.failure);
    } catch (error) {
      await emergencyIfNeeded(env, error);
      console.error(JSON.stringify({
        event: 'collector_diagnostic_postflight_failed',
        error: sanitizeFailureDetail(error?.message || error),
      }));
    }

    try {
      await retireRecoveredPendingAlert(env);
      await discardDisabledDeliveries(env);
    } catch (error) {
      await emergencyIfNeeded(env, error);
      console.error(JSON.stringify({
        event: 'collector_pending_alert_retire_failed',
        error: sanitizeFailureDetail(error?.message || error),
      }));
    }

    let prepared = null;
    try {
      prepared = await prepareDetailedCollectorAlert(env);
      const closedWithoutMail = await closeRecoveredIncidentWithoutEmail(env, prepared);
      if (closedWithoutMail) prepared = await prepareDetailedCollectorAlert(env);
      const cancelledFalseRecovery = await cancelFalseRecoveryPending(env, prepared);
      if (shouldReprepareAfterFalseRecoveryCancel(cancelledFalseRecovery, prepared)) {
        prepared = await prepareDetailedCollectorAlert(env);
      }
    } catch (error) {
      await emergencyIfNeeded(env, error);
      console.error(JSON.stringify({
        event: 'collector_detailed_alert_prepare_failed',
        error: sanitizeFailureDetail(error?.message || error),
      }));
    }

    const detailedAlertReady = Boolean(
      prepared?.diagnosis
      && prepared?.pending === 'alert',
    );

    if (detailedAlertReady) {
      await runCollectorHealthAlert(env).catch(async (error) => {
        await emergencyIfNeeded(env, error);
        console.error(JSON.stringify({
          event: 'collector_health_alert_failed',
          error: sanitizeFailureDetail(error?.message || error),
        }));
      });
    } else {
      console.warn(JSON.stringify({
        event: 'collector_generic_alert_suppressed',
        reason: prepared?.incidentOpen ? 'incident_open_without_pending_alert' : 'diagnostic_alert_not_due',
        code: prepared?.diagnosis?.code || null,
        stage: prepared?.diagnosis?.stage || null,
        consecutive_failures: prepared?.consecutiveFailures || null,
        min_consecutive_failures: prepared?.minConsecutiveFailures || null,
      }));
    }

    if (appError) throw appError;
  },
  async fetch(request, env, ctx) {
    const response = await app.fetch(request, env, ctx);
    if (!new URL(request.url).pathname.endsWith('/health')) return response;
    let payload = null;
    try {
      payload = await response.clone().json();
    } catch {
      return response;
    }
    const collectorHealth = await getCollectorHealthView(env).catch((error) => ({
      collector_health_ok: false,
      collector_health_error_present: true,
      collector_health_error: sanitizeFailureDetail(error?.message || error),
    }));
    return Response.json(sanitizeHealthPayload({
      ...payload,
      ...collectorHealth,
    }), {
      status: healthResponseStatus(response.status, collectorHealth),
    });
  },
};
