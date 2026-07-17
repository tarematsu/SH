import { ensureAuthControlRow, readAuthState } from './auth-state.js';
import { API_BASE, configFromEnv, shHeaders } from './collector-config.js';
import { jwtExpiryMs, normalizeBearer } from './shared.js';

const STATE_ID = 'stationhead';

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function authConfig(env) {
  return {
    requestTimeoutMs: Math.min(positive(env.REQUEST_TIMEOUT_MS, 8_000), 30_000),
    refreshBeforeMs: positive(env.AUTH_REFRESH_BEFORE_MS, 3_600_000),
    cooldownMs: positive(env.AUTH_REFRESH_COOLDOWN_MS, 300_000),
    lockMs: positive(env.AUTH_LOCK_MS, 60_000),
  };
}

async function claimAuthLock(env, cfg) {
  const now = Date.now();
  const result = await env.DB.prepare(`UPDATE sh_worker_auth_control
    SET lock_until=?,last_attempt_at=?,updated_at=?
    WHERE id=? AND COALESCE(lock_until,0)<?`)
    .bind(now + cfg.lockMs, now, now, STATE_ID, now).run();
  return Number(result?.meta?.changes || 0) > 0;
}

async function finishAuthAttempt(env, error = null) {
  const now = Date.now();
  await env.DB.prepare(`UPDATE sh_worker_auth_control SET
      last_success_at=CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,
      last_error=?,lock_until=0,updated_at=? WHERE id=?`)
    .bind(error, now, error, now, STATE_ID).run();
}

function guestHeaders(config, deviceUid, authToken = '') {
  return {
    ...shHeaders({ authToken, deviceUid }, config),
    ...(authToken ? {} : { authorization: '' }),
  };
}

async function acquireSession(env) {
  const cfg = authConfig(env);
  const collectionConfig = configFromEnv(env);
  const deviceUid = crypto.randomUUID();
  const tokenResponse = await fetch(`${API_BASE}/web/token`, {
    method: 'POST',
    headers: guestHeaders(collectionConfig, deviceUid),
    body: '',
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });
  const authToken = normalizeBearer(tokenResponse.headers.get('authorization'));
  if (!tokenResponse.ok || !authToken) throw new Error(`guest token failed: ${tokenResponse.status}`);
  const loginResponse = await fetch(`${API_BASE}/web/guest/login`, {
    method: 'POST',
    headers: guestHeaders(collectionConfig, deviceUid, authToken),
    body: '',
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });
  if (!loginResponse.ok) throw new Error(`guest login failed: ${loginResponse.status}`);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO sh_worker_collector_state(
      id,auth_token,device_uid,token_expires_at,updated_at
    ) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      auth_token=excluded.auth_token,device_uid=excluded.device_uid,
      token_expires_at=excluded.token_expires_at,updated_at=excluded.updated_at`)
    .bind(STATE_ID, authToken, deviceUid, jwtExpiryMs(authToken) || null, now).run();
  await finishAuthAttempt(env);
  return readAuthState(env, STATE_ID);
}

async function ensureSession(env) {
  const cfg = authConfig(env);
  let state = await readAuthState(env, STATE_ID);
  const now = Date.now();
  if (!state.controlExists) await ensureAuthControlRow(env, STATE_ID, now);
  const ready = Boolean(state.authToken && state.deviceUid);
  const expiresSoon = Boolean(state.tokenExpiresAt && state.tokenExpiresAt - now <= cfg.refreshBeforeMs);
  if (ready && !expiresSoon) return state;
  if (ready && state.lastSuccessAt && now - state.lastSuccessAt < cfg.cooldownMs) return state;
  if (!await claimAuthLock(env, cfg)) {
    state = await readAuthState(env, STATE_ID);
    if (state.authToken && state.deviceUid) return state;
    throw new Error('Stationhead auth refresh is locked');
  }
  try {
    return await acquireSession(env);
  } catch (error) {
    await finishAuthAttempt(env, String(error?.message || error).slice(0, 800)).catch(() => {});
    throw error;
  }
}

// Keep this path deliberately opaque: parsing and all queue-track work belong
// to sh-buddies-ingest so collector CPU does not scale with response contents.
export async function collectRawChannel(env, dependencies = {}) {
  if (!env?.RAW_COLLECTION_QUEUE?.send) throw new Error('RAW_COLLECTION_QUEUE binding is missing');
  const state = await (dependencies.ensureSession || ensureSession)(env);
  const config = configFromEnv(env);
  const observedAt = Date.now();
  const response = await (dependencies.fetch || fetch)(
    `${API_BASE}/channels/alias/${encodeURIComponent(config.channelAlias)}`,
    {
      headers: shHeaders(state, config),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    },
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`Stationhead API ${response.status}: channel`);
  const refreshed = normalizeBearer(response.headers.get('authorization'));
  const persistCredentials = !state.collectorUpdatedAt
    || Boolean(refreshed && refreshed !== state.authToken);
  await env.RAW_COLLECTION_QUEUE.send({
    message_type: 'stationhead-raw-channel',
    message_version: 1,
    observed_at: observedAt,
    channel_alias: config.channelAlias,
    body,
    persist_credentials: persistCredentials,
    auth: {
      authToken: refreshed || state.authToken,
      deviceUid: state.deviceUid,
      tokenExpiresAt: refreshed ? jwtExpiryMs(refreshed) : state.tokenExpiresAt,
      collectorLastRunAt: state.collectorLastRunAt,
      collectorLastSuccessAt: state.collectorLastSuccessAt,
      collectorLastError: state.collectorLastError,
      collectorChannelId: state.collectorChannelId,
      collectorStationId: state.collectorStationId,
    },
  }, { contentType: 'json' });
  console.log(JSON.stringify({
    event: 'raw_collection_enqueued',
    observed_at: observedAt,
    payload_chars: body.length,
  }));
}

export default {
  scheduled(_controller, env, ctx) {
    const task = collectRawChannel(env);
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(task);
    return task;
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};