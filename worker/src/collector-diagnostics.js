import {
  asCollectorFailure,
  clearCollectorFailure,
  diagnoseCollectorFailure,
  diagnosisFromState,
  failureEmailLines,
  isD1Failure,
  recordCollectorFailure,
  sanitizeFailureDetail,
  stageLabel,
} from './collector-failure.js';

const STATE_ID = 'stationhead';
const ALERT_ID = 'stationhead-collector';
const DEFAULT_STALE_MS = 60 * 60 * 1000;
const MIN_STALE_MS = 5 * 60 * 1000;
const DEFAULT_RESEND_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_CONSECUTIVE_FAILURES = 2;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Stationhead Monitor <onboarding@resend.dev>';
const PUBLIC_HEALTH_URL = 'https://skrzk.pages.dev/api/health';

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  return String(value ?? '').trim();
}

function config(env = {}) {
  const minConsecutiveFailures = Math.max(
    1,
    Math.trunc(finite(env.HEALTH_ALERT_MIN_CONSECUTIVE_FAILURES) ?? DEFAULT_MIN_CONSECUTIVE_FAILURES),
  );
  return {
    staleMs: Math.max(MIN_STALE_MS, finite(env.HEALTH_ALERT_STALE_MS) ?? DEFAULT_STALE_MS),
    timeoutMs: Math.min(30_000, Math.max(1_000, finite(env.HEALTH_ALERT_RESEND_TIMEOUT_MS) ?? DEFAULT_RESEND_TIMEOUT_MS)),
    minConsecutiveFailures,
    apiKey: text(env.RESEND_API_KEY),
    to: text(env.HEALTH_ALERT_TO),
    from: text(env.HEALTH_ALERT_FROM) || DEFAULT_FROM,
  };
}

function formatJst(timestamp) {
  if (!Number.isFinite(timestamp)) return '不明';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '不明';
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}時間${minutes}分` : `${minutes}分`;
}

async function optionalFirst(db, sql, binds = []) {
  try {
    return { row: await db.prepare(sql).bind(...binds).first(), ready: true };
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return { row: null, ready: false };
    throw error;
  }
}

export async function inspectCollectorState(env) {
  if (!env?.DB) throw asCollectorFailure(new Error('DB binding is missing'), 'd1_read_collector_state');

  let core;
  try {
    core = await env.DB.prepare(`SELECT
        collector.last_run_at,collector.last_success_at,collector.last_error,
        collector.last_channel_id,collector.last_station_id,collector.updated_at AS collector_updated_at,
        auth.last_attempt_at AS auth_last_attempt_at,
        auth.last_success_at AS auth_last_success_at,
        auth.last_error AS auth_last_error,
        auth.updated_at AS auth_updated_at
      FROM (SELECT ? AS id) requested
      LEFT JOIN sh_worker_collector_state collector ON collector.id=requested.id
      LEFT JOIN sh_worker_auth_control auth ON auth.id=requested.id`)
      .bind(STATE_ID).first();
  } catch (error) {
    throw asCollectorFailure(error, 'd1_read_collector_state');
  }

  const [failureResult, alertResult, deliveryResult, snapshotResult] = await Promise.all([
    optionalFirst(env.DB, `SELECT
        first_failure_at AS failure_first_at,
        last_failure_at AS failure_last_at,
        code AS failure_code,stage AS failure_stage,summary AS failure_summary,
        detail AS failure_detail,hint AS failure_hint,source AS failure_source,
        consecutive_failures AS failure_count
      FROM sh_collector_failure_state WHERE id=?`, [STATE_ID]),
    optionalFirst(env.DB, `SELECT id AS alert_id,incident_open,incident_started_at,
        last_alert_at,last_recovery_at,last_observed_success_at,last_error AS alert_last_error,
        updated_at AS alert_updated_at
      FROM sh_health_alert_state WHERE id=?`, [ALERT_ID]),
    optionalFirst(env.DB, `SELECT event_kind AS pending_event_kind,
        idempotency_key AS pending_idempotency_key,last_error AS pending_last_error
      FROM sh_health_alert_delivery WHERE id=?`, [ALERT_ID]),
    optionalFirst(env.DB, `SELECT observed_at AS snapshot_observed_at,
        channel_id AS snapshot_channel_id,channel_alias AS snapshot_channel_alias,
        station_id AS snapshot_station_id,raw_json AS snapshot_raw_json
      FROM sh_channel_snapshots ORDER BY observed_at DESC,id DESC LIMIT 1`),
  ]);

  return {
    ...core,
    ...(failureResult.row || {}),
    ...(alertResult.row || {}),
    ...(deliveryResult.row || {}),
    ...(snapshotResult.row || {}),
    diagnostics_table_ready: failureResult.ready,
    alert_table_ready: alertResult.ready,
    delivery_table_ready: deliveryResult.ready,
    snapshot_table_ready: snapshotResult.ready,
  };
}

function validateLatestSnapshot(state, runStartedAt) {
  const observedAt = finite(state.snapshot_observed_at);
  if (observedAt == null || observedAt < runStartedAt - 5_000) {
    return asCollectorFailure(
      new Error('Stationhead collection reported success but no current channel snapshot was written'),
      'stationhead_channel_payload',
    );
  }
  if (finite(state.snapshot_channel_id) == null || !text(state.snapshot_channel_alias)) {
    return asCollectorFailure(
      new Error('Stationhead channel response shape changed: channel_id or channel_alias is missing'),
      'stationhead_channel_payload',
    );
  }
  if (state.snapshot_raw_json) {
    try {
      const raw = JSON.parse(state.snapshot_raw_json);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('root is not an object');
      }
    } catch (error) {
      return asCollectorFailure(
        new Error(`Stationhead channel response JSON is invalid: ${sanitizeFailureDetail(error?.message || error)}`),
        'stationhead_channel_payload',
      );
    }
  }
  return null;
}

function inferStoredFailure(state, runStartedAt) {
  const lastSuccessAt = finite(state.last_success_at) ?? 0;
  const lastRunAt = finite(state.last_run_at) ?? 0;
  const authAttemptAt = finite(state.auth_last_attempt_at) ?? 0;

  if (state.auth_last_error && authAttemptAt >= Math.max(runStartedAt - 5_000, lastSuccessAt)) {
    return asCollectorFailure(state.auth_last_error, 'stationhead_auth', authAttemptAt);
  }
  if (state.last_error && lastRunAt >= runStartedAt - 5_000 && lastSuccessAt < runStartedAt) {
    const detail = text(state.last_error);
    let stage = 'collector_unknown';
    if (/D1 ingest failed|database|SQLITE|no such table|no such column/i.test(detail)) stage = 'd1_write_snapshot';
    else if (/401|403|session expired|authentication/i.test(detail)) stage = 'stationhead_auth';
    else if (/chatHistory/i.test(detail)) stage = 'stationhead_chat_history';
    else if (/Stationhead API|channels\/alias/i.test(detail)) stage = 'stationhead_channel_request';
    return asCollectorFailure(detail, stage, lastRunAt);
  }
  return null;
}

async function probeD1Write(env, now) {
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sh_collector_failure_state (
          id,first_failure_at,last_failure_at,code,stage,summary,detail,hint,source,
          consecutive_failures,updated_at
        ) VALUES ('diagnostic-write-probe',?,?,?,?,?,?,?,?,1,?)
        ON CONFLICT(id) DO UPDATE SET last_failure_at=excluded.last_failure_at,updated_at=excluded.updated_at`)
        .bind(now, now, 'D1_WRITE_PROBE', 'd1_write_collector_state', 'D1 write probe', null, null, 'diagnostic', now),
      env.DB.prepare(`DELETE FROM sh_collector_failure_state WHERE id='diagnostic-write-probe'`),
    ]);
    return null;
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return null;
    return asCollectorFailure(error, 'd1_write_collector_state', now);
  }
}

function failureAlreadyRecordedThisRun(state, runStartedAt) {
  const failureAt = finite(state?.failure_last_at);
  return Boolean(
    failureAt != null
      && failureAt >= runStartedAt - 5_000
      && text(state?.failure_code),
  );
}

export async function diagnoseScheduledCollection(env, before, runStartedAt, appError = null) {
  let after;
  try {
    after = await inspectCollectorState(env);
  } catch (error) {
    return { state: null, failure: asCollectorFailure(error, 'd1_read_collector_state', Date.now()) };
  }

  let failure = appError ? asCollectorFailure(appError, 'collector_unknown', Date.now()) : null;
  if (!failure) failure = inferStoredFailure(after, runStartedAt);

  const lastSuccessAt = finite(after.last_success_at) ?? 0;
  if (!failure && lastSuccessAt >= runStartedAt) failure = validateLatestSnapshot(after, runStartedAt);

  if (!failure && lastSuccessAt < runStartedAt) {
    failure = await probeD1Write(env, Date.now());
    if (!failure) {
      failure = asCollectorFailure(
        new Error('Scheduled collection ended without updating last_success_at and without a recorded error'),
        'collector_unknown',
      );
    }
  }

  if (failure) {
    if (!failureAlreadyRecordedThisRun(after, runStartedAt)) {
      await recordCollectorFailure(env, failure, failure.diagnosis?.stage || 'collector_unknown', 'scheduled-guard')
        .catch(() => {});
    }
  } else if (lastSuccessAt >= runStartedAt && (!before || lastSuccessAt > (finite(before.last_success_at) ?? 0))) {
    await clearCollectorFailure(env).catch((error) => {
      console.warn(JSON.stringify({
        event: 'collector_failure_clear_failed',
        error: sanitizeFailureDetail(error?.message || error),
      }));
    });
  }

  return { state: after, failure };
}

function detailedAlertBody(state, diagnosis, now, minConsecutiveFailures, referenceAt) {
  return [
    `Stationheadの収集で${minConsecutiveFailures}回連続の取得エラーを検知しました。`,
    '',
    ...failureEmailLines(diagnosis),
    '',
    `最終成功: ${formatJst(finite(state.last_success_at))}`,
    `最終実行: ${formatJst(finite(state.last_run_at))}`,
    `障害開始基準: ${formatJst(referenceAt)}`,
    `監視上の経過: ${formatDuration(now - referenceAt)}`,
    `確認時刻: ${formatJst(now)}`,
    '',
    '復旧通知は送信しません。',
    '',
    `Health: ${PUBLIC_HEALTH_URL}`,
  ].join('\n');
}

export async function prepareDetailedCollectorAlert(env, now = Date.now()) {
  const cfg = config(env);
  const state = await inspectCollectorState(env);
  const diagnosis = diagnosisFromState(state);
  const incidentOpen = Number(state.incident_open || 0) === 1;
  const pending = text(state.pending_event_kind) || null;

  if (!diagnosis) return { state, diagnosis: null, incidentOpen, pending, prepared: false };

  const consecutiveFailures = finite(diagnosis.count) ?? 1;
  const ready = consecutiveFailures >= cfg.minConsecutiveFailures;
  if (!ready || incidentOpen || pending || !cfg.apiKey || !cfg.to || !state.delivery_table_ready) {
    return {
      state,
      diagnosis,
      incidentOpen,
      pending,
      consecutiveFailures,
      minConsecutiveFailures: cfg.minConsecutiveFailures,
      stale: ready,
      prepared: false,
    };
  }

  const referenceAt = finite(diagnosis.firstAt) ?? finite(diagnosis.at) ?? finite(state.last_success_at) ?? now;
  const subject = `【Stationhead Monitor】収集エラーが${cfg.minConsecutiveFailures}回連続`;
  const idempotencyKey = `stationhead-monitor-diagnostic-${referenceAt}-${cfg.minConsecutiveFailures}-${diagnosis.code}`;
  await env.DB.prepare(`INSERT OR IGNORE INTO sh_health_alert_delivery (
      id,event_kind,incident_started_at,observed_at,baseline_success_at,stale_ms,
      subject,body,from_address,to_address,idempotency_key,created_at,last_attempt_at,last_error,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)`)
    .bind(
      ALERT_ID,
      'alert',
      referenceAt,
      now,
      finite(state.last_success_at),
      null,
      subject,
      detailedAlertBody(state, diagnosis, now, cfg.minConsecutiveFailures, referenceAt),
      cfg.from,
      cfg.to,
      idempotencyKey,
      now,
      now,
    ).run();

  return {
    state,
    diagnosis,
    incidentOpen,
    pending: 'alert',
    consecutiveFailures,
    minConsecutiveFailures: cfg.minConsecutiveFailures,
    stale: true,
    prepared: true,
  };
}

function shortHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function sendEmergencyD1Alert(env, error, now = Date.now()) {
  const diagnosis = diagnoseCollectorFailure(error, error?.diagnosis?.stage || 'd1_read_collector_state', now);
  if (!isD1Failure(diagnosis)) return { ok: false, skipped: 'not a D1 failure' };

  const cfg = config(env);
  if (!cfg.apiKey || !cfg.to) return { ok: false, skipped: 'Resend is not configured' };
  const hourBucket = Math.floor(now / 3_600_000) * 3_600_000;
  const requestIdentity = `${diagnosis.code}:${diagnosis.stage}:${cfg.from}:${cfg.to}`;
  const body = [
    'D1障害のため通常の監視状態やメール配送キューへ記録できない可能性があります。',
    '',
    `推定原因: ${diagnosis.summary}`,
    `原因コード: ${diagnosis.code}`,
    `失敗段階: ${diagnosis.stageLabel || stageLabel(diagnosis.stage)}`,
    `検知時間枠: ${formatJst(hourBucket)}`,
    `確認候補: ${diagnosis.hint}`,
    '',
    'この通知はD1を経由せずResendへ直接送信しています。',
  ].join('\n');

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': `stationhead-monitor-d1-${hourBucket}-${shortHash(requestIdentity)}`,
    },
    body: JSON.stringify({
      from: cfg.from,
      to: [cfg.to],
      subject: `【Stationhead Monitor】${diagnosis.summary}`,
      text: body,
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Emergency Resend HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  return { ok: true, code: diagnosis.code };
}

export async function diagnosticHealthView(env, now = Date.now()) {
  try {
    const state = await inspectCollectorState(env);
    const diagnosis = diagnosisFromState(state);
    if (!diagnosis) {
      return {
        collector_failure_active: false,
        collector_failure_diagnostics_setup_required: !state.diagnostics_table_ready,
      };
    }
    return {
      collector_health_ok: false,
      collector_failure_active: true,
      collector_failure_code: diagnosis.code,
      collector_failure_stage: diagnosis.stage,
      collector_failure_summary: diagnosis.summary,
      collector_failure_first_at: finite(diagnosis.firstAt) ?? finite(diagnosis.at),
      collector_failure_last_at: finite(diagnosis.at),
      collector_failure_count: finite(diagnosis.count),
      collector_failure_diagnostics_setup_required: !state.diagnostics_table_ready,
      checked_at: now,
    };
  } catch (error) {
    const diagnosis = diagnoseCollectorFailure(error, 'd1_read_collector_state', now);
    return {
      collector_health_ok: false,
      collector_failure_active: true,
      collector_failure_code: diagnosis.code,
      collector_failure_stage: diagnosis.stage,
      collector_failure_summary: diagnosis.summary,
      collector_failure_diagnostics_setup_required: true,
      checked_at: now,
    };
  }
}
