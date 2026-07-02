const ALERT_ID = 'stationhead-collector';
const DEFAULT_STALE_MS = 60 * 60 * 1000;
const MIN_STALE_MS = 5 * 60 * 1000;
const DEFAULT_RESEND_TIMEOUT_MS = 10_000;
const MIN_RESEND_TIMEOUT_MS = 1_000;
const MAX_RESEND_TIMEOUT_MS = 30_000;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Stationhead Monitor <onboarding@resend.dev>';
const PUBLIC_HEALTH_URL = 'https://skrzk.pages.dev/api/health';

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
  if (!hours) return `${minutes}分`;
  return `${hours}時間${minutes}分`;
}

export function buildAlertEmail(health, now, staleMs) {
  const incidentStartedAt = health.referenceAt ?? now;
  const thresholdReachedAt = incidentStartedAt + staleMs;
  return {
    eventKind: 'alert',
    subject: '【Stationhead Monitor】収集停止を検知',
    idempotencyKey: `stationhead-monitor-down-${incidentStartedAt}-${staleMs}`,
    incidentStartedAt,
    observedAt: now,
    baselineSuccessAt: health.lastSuccessAt,
    staleMs,
    body: [
      `Stationheadの収集が${formatDuration(staleMs)}以上成功していません。`,
      '',
      `最終成功: ${formatJst(health.lastSuccessAt)}`,
      `最終実行: ${formatJst(health.lastRunAt)}`,
      `障害開始基準: ${formatJst(incidentStartedAt)}`,
      `停止判定到達: ${formatJst(thresholdReachedAt)}`,
      `停止時間: ${formatDuration(health.ageMs)}`,
      `確認時刻: ${formatJst(now)}`,
      `直近エラー: ${health.lastError || '記録なし'}`,
      '',
      `Health: ${PUBLIC_HEALTH_URL}`,
    ].join('\n'),
  };
}

export function buildRecoveryEmail(health, state, now) {
  const incidentStartedAt = finite(state?.incident_started_at);
  const incidentKey = incidentStartedAt
    ?? finite(state?.last_alert_at)
    ?? finite(state?.last_observed_success_at)
    ?? 0;
  const recoveredAt = health.lastSuccessAt ?? now;
  return {
    eventKind: 'recovery',
    subject: '【Stationhead Monitor】収集が復旧しました',
    idempotencyKey: `stationhead-monitor-recovered-${incidentKey}`,
    incidentStartedAt: incidentKey,
    observedAt: recoveredAt,
    baselineSuccessAt: finite(state?.last_observed_success_at),
    staleMs: null,
    body: [
      'Stationheadの収集が正常状態へ復帰しました。',
      '',
      `復旧確認: ${formatJst(recoveredAt)}`,
      `最新成功: ${formatJst(recoveredAt)}`,
      `障害開始基準: ${formatJst(incidentStartedAt)}`,
      `障害時間: ${incidentStartedAt == null ? '不明' : formatDuration(recoveredAt - incidentStartedAt)}`,
      '',
      `Health: ${PUBLIC_HEALTH_URL}`,
    ].join('\n'),
  };
}

export function storedDeliveryEmail(state) {
  const eventKind = text(state?.pending_event_kind);
  const subject = text(state?.pending_subject);
  const body = String(state?.pending_body || '');
  const idempotencyKey = text(state?.pending_idempotency_key);
  const from = text(state?.pending_from_address);
  const to = text(state?.pending_to_address);
  if (!eventKind || !subject || !body || !idempotencyKey || !from || !to) return null;
  return {
    eventKind,
    subject,
    body,
    idempotencyKey,
    incidentStartedAt: finite(state?.pending_incident_started_at),
    observedAt: finite(state?.pending_observed_at),
    baselineSuccessAt: finite(state?.pending_baseline_success_at),
    staleMs: finite(state?.pending_stale_ms),
    from,
    to,
  };
}

async function sendResend(env, email) {
  const cfg = healthAlertConfig(env);
  const from = text(email.from) || cfg.from;
  const to = text(email.to) || cfg.to;
  if (!cfg.apiKey || !to) throw new Error('RESEND_API_KEY or HEALTH_ALERT_TO is not configured');
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': email.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: email.subject,
      text: email.body,
    }),
    signal: AbortSignal.timeout(cfg.resendTimeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
  }
  return response.json().catch(() => ({}));
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

async function ensureAlertRow(env, state, now) {
  if (!state.alert_table_ready || state.alert_id) return state;
  await env.DB.prepare(`INSERT OR IGNORE INTO sh_health_alert_state
      (id,incident_open,last_observed_success_at,updated_at)
      VALUES (?,0,?,?)`)
    .bind(ALERT_ID, finite(state.last_success_at), now).run();
  return loadState(env);
}

async function ensureInitialFailureWindow(env, state, health, now) {
  if (health.lastSuccessAt != null || finite(state.incident_started_at) != null) return state;
  const startedAt = health.lastRunAt ?? now;
  await env.DB.prepare(`UPDATE sh_health_alert_state
      SET incident_started_at=?,updated_at=?
      WHERE id=? AND incident_started_at IS NULL AND incident_open=0`)
    .bind(startedAt, now, ALERT_ID).run();
  return loadState(env);
}

async function createPendingDelivery(env, email, now) {
  const cfg = healthAlertConfig(env);
  await env.DB.prepare(`INSERT OR IGNORE INTO sh_health_alert_delivery (
      id,event_kind,incident_started_at,observed_at,baseline_success_at,stale_ms,
      subject,body,from_address,to_address,idempotency_key,created_at,last_attempt_at,last_error,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)`)
    .bind(
      ALERT_ID,
      email.eventKind,
      email.incidentStartedAt,
      email.observedAt,
      email.baselineSuccessAt,
      email.staleMs,
      email.subject,
      email.body,
      cfg.from,
      cfg.to,
      email.idempotencyKey,
      now,
      now,
    ).run();
  return loadState(env);
}

async function saveDeliveryError(env, delivery, error, now) {
  const message = String(error?.message || error).slice(0, 1000);
  await env.DB.batch([
    env.DB.prepare(`UPDATE sh_health_alert_delivery
      SET last_attempt_at=?,last_error=?,updated_at=?
      WHERE id=? AND idempotency_key=?`)
      .bind(now, message, now, ALERT_ID, delivery.idempotencyKey),
    env.DB.prepare(`UPDATE sh_health_alert_state SET last_error=?,updated_at=? WHERE id=?`)
      .bind(message, now, ALERT_ID),
  ]);
}

async function finalizeDelivery(env, delivery, now) {
  let stateUpdate;
  if (delivery.eventKind === 'alert') {
    stateUpdate = env.DB.prepare(`UPDATE sh_health_alert_state SET
        incident_open=1,incident_started_at=?,last_alert_at=?,
        last_observed_success_at=?,last_error=NULL,updated_at=?
        WHERE id=?`)
      .bind(
        delivery.incidentStartedAt,
        now,
        delivery.baselineSuccessAt,
        now,
        ALERT_ID,
      );
  } else if (delivery.eventKind === 'recovery') {
    stateUpdate = env.DB.prepare(`UPDATE sh_health_alert_state SET
        incident_open=0,incident_started_at=NULL,last_recovery_at=?,
        last_observed_success_at=?,last_error=NULL,updated_at=?
        WHERE id=?`)
      .bind(
        delivery.observedAt ?? now,
        delivery.observedAt,
        now,
        ALERT_ID,
      );
  } else {
    throw new Error(`Unknown health delivery event: ${delivery.eventKind}`);
  }

  await env.DB.batch([
    stateUpdate,
    env.DB.prepare(`DELETE FROM sh_health_alert_delivery
      WHERE id=? AND idempotency_key=?`)
      .bind(ALERT_ID, delivery.idempotencyKey),
  ]);
}

async function processPendingDelivery(env, state, now) {
  const delivery = storedDeliveryEmail(state);
  if (!delivery) return null;
  try {
    await sendResend(env, delivery);
    await finalizeDelivery(env, delivery, now);
    console.log(JSON.stringify({
      event: `collector_health_${delivery.eventKind}_sent`,
      incident_started_at: delivery.incidentStartedAt,
      observed_at: delivery.observedAt,
    }));
    return { ok: true, sent: delivery.eventKind };
  } catch (error) {
    await saveDeliveryError(env, delivery, error, now).catch(() => {});
    throw error;
  }
}

async function clearResolvedPendingState(env, state, health, now) {
  const pendingStartedAt = finite(state.incident_started_at);
  const errorAt = state.alert_last_error ? finite(state.alert_updated_at) : null;
  const baseline = Math.max(pendingStartedAt ?? 0, errorAt ?? 0);
  if (health.lastSuccessAt == null || health.lastSuccessAt <= baseline) return false;
  if (pendingStartedAt == null && !state.alert_last_error) return false;
  await env.DB.prepare(`UPDATE sh_health_alert_state
      SET incident_started_at=NULL,last_observed_success_at=?,last_error=NULL,updated_at=?
      WHERE id=? AND incident_open=0`)
    .bind(health.lastSuccessAt, now, ALERT_ID).run();
  return true;
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

export async function runCollectorHealthAlert(env, now = Date.now()) {
  if (!env.DB) return { ok: false, skipped: 'DB binding missing' };
  const cfg = healthAlertConfig(env);
  let state = await loadState(env);
  if (!state.alert_table_ready) return { ok: false, skipped: 'health alert migration required' };
  if (!state.delivery_table_ready) return { ok: false, skipped: 'health alert delivery migration required' };
  state = await ensureAlertRow(env, state, now);

  if (storedDeliveryEmail(state)) return processPendingDelivery(env, state, now);

  let health = evaluateCollectorHealth(state, now, cfg.staleMs);
  state = await ensureInitialFailureWindow(env, state, health, now);
  health = evaluateCollectorHealth(state, now, cfg.staleMs);
  if (health.referenceAt == null) return { ok: true, skipped: 'collector has not started yet' };

  const incidentOpen = enabledFlag(state.incident_open);
  if (!incidentOpen && health.stale) {
    if (!cfg.enabled) return { ok: false, skipped: 'Resend is not configured', stale: true };
    state = await createPendingDelivery(env, buildAlertEmail(health, now, cfg.staleMs), now);
    return processPendingDelivery(env, state, now);
  }

  if (incidentOpen && hasCollectorRecovered(state, health)) {
    if (!cfg.enabled) return { ok: false, skipped: 'Resend is not configured', recovery_pending: true };
    state = await createPendingDelivery(env, buildRecoveryEmail(health, state, now), now);
    return processPendingDelivery(env, state, now);
  }

  if (!incidentOpen && !health.stale) {
    const cleared = await clearResolvedPendingState(env, state, health, now);
    if (cleared) return { ok: true, stale: false, incidentOpen: false, pendingStateCleared: true };
  }

  return {
    ok: true,
    stale: health.stale,
    incidentOpen,
    recoveryPending: incidentOpen && hasCollectorRecovered(state, health),
  };
}

export async function sendCollectorHealthTest(env, now = Date.now()) {
  const state = env.DB ? await loadState(env) : {};
  const cfg = healthAlertConfig(env);
  const health = evaluateCollectorHealth(state, now, cfg.staleMs);
  await sendResend(env, {
    subject: '【Stationhead Monitor】Resendテスト通知',
    idempotencyKey: `stationhead-monitor-test-${now}`,
    body: [
      'Stationhead監視メールの送信テストです。',
      '',
      `送信時刻: ${formatJst(now)}`,
      `現在の判定: ${health.stale ? '停止' : health.referenceAt == null ? '未計測' : '正常'}`,
      `最終成功: ${formatJst(health.lastSuccessAt)}`,
      '',
      `Health: ${PUBLIC_HEALTH_URL}`,
    ].join('\n'),
  });
  return { ok: true, to: cfg.to };
}
