import app from './main.js';
import { getCollectorHealthView, runCollectorHealthAlert } from './health-alert.js';
import { retireRecoveredPendingAlert } from './health-alert-guard.js';
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
  if (baseStatus >= 200 && baseStatus < 300 && collectorHealth?.collector_health_ok === false) {
    return 503;
  }
  return baseStatus;
}

function changed(result) {
  return Number(result?.meta?.changes || 0) > 0;
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
  if (!env?.DB || !lastSuccessAt || !failureAt || failureAt < lastSuccessAt) return false;
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
      await cancelFalseRecoveryPending(env, prepared);
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
    const shouldRunStandardAlert = !prepared?.diagnosis || detailedAlertReady;

    if (shouldRunStandardAlert) {
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
        reason: prepared?.incidentOpen ? 'active_failure_diagnostic' : 'diagnostic_alert_not_due',
        code: prepared?.diagnosis?.code || null,
        stage: prepared?.diagnosis?.stage || null,
      }));
    }

    if (appError) throw appError;
    return diagnosticResult;
  },

  async fetch(request, env, ctx) {
    const response = await app.fetch(request, env, ctx);
    const url = new URL(request.url);
    if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/health')) return response;
    const [payload, collectorHealth, diagnostics] = await Promise.all([
      response.json().catch(() => null),
      getCollectorHealthView(env).catch((error) => {
        console.error(JSON.stringify({
          event: 'collector_health_view_failed',
          error: sanitizeFailureDetail(error?.message || error),
        }));
        return {
          collector_health_ok: false,
          collector_health_error: 'health_check_failed',
        };
      }),
      diagnosticHealthView(env),
    ]);
    if (!payload) return response;
    const mergedHealth = { ...collectorHealth, ...diagnostics };
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    return new Response(JSON.stringify({
      ...sanitizeHealthPayload(payload),
      ...mergedHealth,
    }), {
      status: healthResponseStatus(response.status, mergedHealth),
      headers,
    });
  },
};
