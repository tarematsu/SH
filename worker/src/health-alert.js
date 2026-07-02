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
  const incidentStartedAt = (health.referenceAt ?? now) + staleMs;
  return {
    subject: '【Stationhead Monitor】収集停止を検知',
    idempotencyKey: `stationhead-monitor-down-${incidentStartedAt}`,
    incidentStartedAt,
    body: [
      `Stationheadの収集が${formatDuration(staleMs)}以上成功していません。`,
      '',
      `最終成功: ${formatJst(health.lastSuccessAt)}`,
      `最終実行: ${formatJst(health.lastRunAt)}`,
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
  return {
    subject: '【Stationhead Monitor】収集が復旧しました',
    idempotencyKey: `stationhead-monitor-recovered-${incidentStartedAt || now}-${health.lastSuccessAt || now}`,
    body: [
      'Stationheadの収集が正常状態へ復帰しました。',
      '',
      `復旧確認: ${formatJst(now)}`,
      `最新成功: ${formatJst(health.lastSuccessAt)}`,
      `障害開始: ${formatJst(incidentStartedAt)}`,
      `障害時間: ${incidentStartedAt == null ? '不明' : formatDuration(now - incidentStartedAt)}`,
      '',
      `Health: ${PUBLIC_HEALTH_URL}`,
    ].join('\n'),
  };
}

async function sendResend(env, email) {
  const cfg = healthAlertConfig(env);
  if (!cfg.enabled) throw new Error('RESEND_API_KEY or HEALTH_ALERT_TO is not configured');
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': email.idempotencyKey,
    },
    body: JSON.stringify({
      from: cfg.from,
      to: [cfg.to],
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

async function loadState(env) {
  try {
    const row = await env.DB.prepare(`SELECT
        collector.last_run_at,collector.last_success_at,collector.last_error,
        alert.id AS alert_id,alert.incident_open,alert.incident_started_at,
        alert.last_alert_at,alert.last_recovery_at,alert.last_observed_success_at,
        alert.last_error AS alert_last_error,alert.updated_at AS alert_updated_at
      FROM (SELECT ? AS id) requested
      LEFT JOIN sh_worker_collector_state collector ON collector.id='stationhead'
      LEFT JOIN sh_health_alert_state alert ON alert.id=requested.id`)
      .bind(ALERT_ID).first();
    return { ...row, alert_table_ready: true };
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
    const row = await env.DB.prepare(`SELECT last_run_at,last_success_at,last_error
      FROM sh_worker_collector_state WHERE id='stationhead'`).first();
    return { ...row, alert_table_ready: false };
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
      WHERE id=? AND incident_started_at IS NULL`)
    .bind(startedAt, now, ALERT_ID).run();
  return loadState(env);
}

async function clearPendingInitialWindow(env, now) {
  await env.DB.prepare(`UPDATE sh_health_alert_state
      SET incident_started_at=NULL,last_observed_success_at=(
        SELECT last_success_at FROM sh_worker_collector_state WHERE id='stationhead'
      ),updated_at=?
      WHERE id=? AND incident_open=0`)
    .bind(now, ALERT_ID).run();
}

async function saveAlertOpened(env, email, health, now) {
  await env.DB.prepare(`UPDATE sh_health_alert_state SET
      incident_open=1,incident_started_at=?,last_alert_at=?,
      last_observed_success_at=?,last_error=NULL,updated_at=?
      WHERE id=?`)
    .bind(email.incidentStartedAt, now, health.lastSuccessAt, now, ALERT_ID).run();
}

async function saveAlertRecovered(env, health, now) {
  await env.DB.prepare(`UPDATE sh_health_alert_state SET
      incident_open=0,incident_started_at=NULL,last_recovery_at=?,
      last_observed_success_at=?,last_error=NULL,updated_at=?
      WHERE id=?`)
    .bind(now, health.lastSuccessAt, now, ALERT_ID).run();
}

async function saveAlertError(env, error, now) {
  const message = String(error?.message || error).slice(0, 1000);
  await env.DB.prepare(`UPDATE sh_health_alert_state SET last_error=?,updated_at=? WHERE id=?`)
    .bind(message, now, ALERT_ID).run();
}

export async function getCollectorHealthView(env, now = Date.now()) {
  if (!env.DB) return { collector_health_ok: false, collector_health_setup_required: true };
  const cfg = healthAlertConfig(env);
  const state = await loadState(env);
  const health = evaluateCollectorHealth(state, now, cfg.staleMs);
  return {
    collector_health_ok: health.referenceAt != null && !health.stale,
    collector_health_stale: health.stale,
    collector_health_age_ms: health.ageMs,
    collector_health_stale_after_ms: cfg.staleMs,
    collector_last_run_at: health.lastRunAt,
    collector_last_success_at: health.lastSuccessAt,
    collector_last_error_present: Boolean(health.lastError),
    health_alert_configured: cfg.enabled,
    health_alert_incident_open: Boolean(state.incident_open),
    health_alert_last_sent_at: finite(state.last_alert_at),
    health_alert_last_recovery_at: finite(state.last_recovery_at),
    health_alert_last_error_present: Boolean(state.alert_last_error),
    health_alert_setup_required: !state.alert_table_ready,
  };
}

export async function runCollectorHealthAlert(env, now = Date.now()) {
  if (!env.DB) return { ok: false, skipped: 'DB binding missing' };
  const cfg = healthAlertConfig(env);
  let state = await loadState(env);
  if (!state.alert_table_ready) return { ok: false, skipped: 'health alert migration required' };
  state = await ensureAlertRow(env, state, now);
  let health = evaluateCollectorHealth(state, now, cfg.staleMs);
  state = await ensureInitialFailureWindow(env, state, health, now);
  health = evaluateCollectorHealth(state, now, cfg.staleMs);
  if (health.referenceAt == null) return { ok: true, skipped: 'collector has not started yet' };

  const incidentOpen = Boolean(state.incident_open);
  if (!health.stale && !incidentOpen && health.lastSuccessAt != null && finite(state.incident_started_at) != null) {
    await clearPendingInitialWindow(env, now);
    return { ok: true, stale: false, incidentOpen: false, initialWindowCleared: true };
  }

  if (health.stale && !incidentOpen) {
    if (!cfg.enabled) return { ok: false, skipped: 'Resend is not configured', stale: true };
    const email = buildAlertEmail(health, now, cfg.staleMs);
    try {
      await sendResend(env, email);
      await saveAlertOpened(env, email, health, now);
      console.warn(JSON.stringify({ event: 'collector_health_alert_sent', incident_started_at: email.incidentStartedAt }));
      return { ok: true, sent: 'alert', stale: true };
    } catch (error) {
      await saveAlertError(env, error, now).catch(() => {});
      throw error;
    }
  }

  if (!health.stale && incidentOpen) {
    if (!cfg.enabled) return { ok: false, skipped: 'Resend is not configured', recovery_pending: true };
    const email = buildRecoveryEmail(health, state, now);
    try {
      await sendResend(env, email);
      await saveAlertRecovered(env, health, now);
      console.log(JSON.stringify({ event: 'collector_health_recovery_sent', last_success_at: health.lastSuccessAt }));
      return { ok: true, sent: 'recovery', stale: false };
    } catch (error) {
      await saveAlertError(env, error, now).catch(() => {});
      throw error;
    }
  }

  return { ok: true, stale: health.stale, incidentOpen };
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
