import { ensureAuthControlRow, readAuthState } from './auth-state.js';
import { API_BASE, configFromEnv, shHeaders } from './collector-config.js';
import { jwtExpiryMs, normalizeBearer } from './shared.js';

const STATE_ID = 'stationhead';
const RAW_COLLECTION_QUEUE_OPTIONS = Object.freeze({ contentType: 'json' });
const SESSION_CACHE_TTL_MS = 5 * 60_000;
const sessionCache = new WeakMap();

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function enabled(value) {
  return value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value || ''));
}

function authConfig(env) {
  return {
    requestTimeoutMs: Math.min(positive(env.REQUEST_TIMEOUT_MS, 8_000), 30_000),
    refreshBeforeMs: positive(env.AUTH_REFRESH_BEFORE_MS, 3_600_000),
    cooldownMs: positive(env.AUTH_REFRESH_COOLDOWN_MS, 300_000),
    lockMs: positive(env.AUTH_LOCK_MS, 60_000),
  };
}

function collectorRequestConfig(env) {
  return {
    channelAlias: env.CHANNEL_ALIAS || 'buddies',
    appVersion: env.STATIONHEAD_APP_VERSION || env.SH_APP_VERSION || '1.0.0',
    requestTimeoutMs: Math.min(positive(env.REQUEST_TIMEOUT_MS, 15_000), 30_000),
  };
}

function sessionCacheKey(env) {
  const db = env?.DB;
  return db && (typeof db === 'object' || typeof db === 'function') ? db : null;
}

function cachedSession(env, cfg, now = Date.now()) {
  const key = sessionCacheKey(env);
  if (!key) return null;
  const entry = sessionCache.get(key);
  if (!entry || entry.expiresAt <= now) {
    if (entry) sessionCache.delete(key);
    return null;
  }
  const state = entry.state;
  if (state.tokenExpiresAt && state.tokenExpiresAt - now <= cfg.refreshBeforeMs) {
    sessionCache.delete(key);
    return null;
  }
  return { ...state };
}

function rememberSession(env, state, now = Date.now()) {
  const key = sessionCacheKey(env);
  if (key && state?.authToken && state?.deviceUid) {
    sessionCache.set(key, {
      expiresAt: now + SESSION_CACHE_TTL_MS,
      state: { ...state },
    });
  }
  return state;
}

function forgetSession(env) {
  const key = sessionCacheKey(env);
  if (key) sessionCache.delete(key);
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

export async function ensureSession(env) {
  const cfg = authConfig(env);
  const now = Date.now();
  const cached = cachedSession(env, cfg, now);
  if (cached) return cached;

  let state = await readAuthState(env, STATE_ID);
  if (!state.controlExists) {
    await ensureAuthControlRow(env, STATE_ID, now);
    state = { ...state, controlExists: true };
  }
  const ready = Boolean(state.authToken && state.deviceUid);
  const expiresSoon = Boolean(state.tokenExpiresAt && state.tokenExpiresAt - now <= cfg.refreshBeforeMs);
  if (ready && !expiresSoon) return rememberSession(env, state, now);
  if (ready && state.lastSuccessAt && now - state.lastSuccessAt < cfg.cooldownMs) {
    return rememberSession(env, state, now);
  }
  if (!await claimAuthLock(env, cfg)) {
    state = await readAuthState(env, STATE_ID);
    if (state.authToken && state.deviceUid) return rememberSession(env, state, now);
    throw new Error('Stationhead auth refresh is locked');
  }
  try {
    state = await acquireSession(env);
    return rememberSession(env, state, now);
  } catch (error) {
    forgetSession(env);
    await finishAuthAttempt(env, String(error?.message || error).slice(0, 800)).catch(() => {});
    throw error;
  }
}

function rawMessage(base, body) {
  base.message_version = 1;
  base.body = body;
  return base;
}

async function directPreparedMessage(base, body, config, env) {
  let channel;
  try {
    channel = JSON.parse(body);
  } catch {
    return rawMessage(base, body);
  }
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
    return rawMessage(base, body);
  }
  try {
    const [payload, queueAnalysis, materialization, snapshotAnalysis] = await Promise.all([
      import('./collector-payload.js'),
      import('./queue-analysis-transfer.js'),
      import('./queue-materialization.js'),
      import('./snapshot-analysis-transfer.js'),
    ]);
    const state = {
      channelId: base.auth?.collectorChannelId ?? null,
      stationId: base.auth?.collectorStationId ?? null,
    };
    payload.validateChannelPayload(channel, config.channelAlias);
    payload.extractIds(channel, state);
    const snapshot = payload.normalizeSnapshot(channel, state, config);
    const fullQueue = payload.extractQueue(channel, state.stationId);
    const [preparedSnapshot, preparedQueue] = await Promise.all([
      snapshotAnalysis.prepareSnapshotAnalysis(snapshot),
      queueAnalysis.prepareQueueAnalysis(fullQueue),
    ]);
    const materialized = await materialization.prepareMaterializedQueue(
      env?.DB,
      fullQueue,
      preparedQueue,
      env,
    );
    base.message_version = 3;
    base.snapshot = snapshot;
    base.queue = materialized.queue;
    if (preparedSnapshot) base.snapshot_analysis = preparedSnapshot;
    if (materialized.analysis) base.queue_analysis = materialized.analysis;
    return base;
  } catch {
    base.message_version = 2;
    base.channel = channel;
    return base;
  }
}

export async function collectRawChannel(env, dependencies = {}) {
  const inlinePipeline = enabled(env?.COLLECTOR_INLINE_PIPELINE_ENABLED);
  const rawCollectionQueue = env?.RAW_COLLECTION_QUEUE;
  const ingestInline = dependencies.ingestRawCollection;
  if (inlinePipeline && typeof ingestInline !== 'function') {
    throw new Error('inline raw collection ingest handler is missing');
  }
  if (!inlinePipeline && typeof rawCollectionQueue?.send !== 'function') {
    throw new Error('RAW_COLLECTION_QUEUE binding is missing');
  }

  const state = await (dependencies.ensureSession || ensureSession)(env);
  const inlinePreparation = inlinePipeline || (!env.DB && dependencies.inlinePreparation !== false);
  const config = inlinePreparation ? configFromEnv(env) : collectorRequestConfig(env);
  const observedAt = Date.now();
  const response = await (dependencies.fetch || fetch)(
    `${API_BASE}/channels/alias/${encodeURIComponent(config.channelAlias)}`,
    {
      headers: shHeaders(state, config),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    },
  );
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) forgetSession(env);
    throw new Error(`Stationhead API ${response.status}: channel`);
  }

  const body = await response.text();
  const refreshed = normalizeBearer(response.headers.get('authorization'));
  const persistCredentials = !state.collectorUpdatedAt
    || Boolean(refreshed && refreshed !== state.authToken);
  const activeToken = refreshed || state.authToken;
  const activeExpiry = refreshed ? jwtExpiryMs(refreshed) : state.tokenExpiresAt;
  const base = {
    message_type: 'stationhead-raw-channel',
    observed_at: observedAt,
    channel_alias: config.channelAlias,
    persist_credentials: persistCredentials,
    auth: {
      authToken: activeToken,
      deviceUid: state.deviceUid,
      tokenExpiresAt: activeExpiry,
      collectorLastRunAt: state.collectorLastRunAt,
      collectorLastSuccessAt: state.collectorLastSuccessAt,
      collectorLastError: state.collectorLastError,
      collectorChannelId: state.collectorChannelId,
      collectorStationId: state.collectorStationId,
    },
  };
  const message = inlinePreparation
    ? await directPreparedMessage(base, body, config, env)
    : rawMessage(base, body);
  if (inlinePipeline) await ingestInline(env, message, { inline: true });
  else await rawCollectionQueue.send(message, RAW_COLLECTION_QUEUE_OPTIONS);
  rememberSession(env, {
    ...state,
    authToken: activeToken,
    tokenExpiresAt: activeExpiry,
    collectorLastRunAt: observedAt,
    collectorLastSuccessAt: observedAt,
    collectorLastError: null,
    collectorUpdatedAt: state.collectorUpdatedAt || observedAt,
  }, observedAt);

  let queueTotalTracks = 0;
  let queueMaterializedTracks = 0;
  if (inlinePreparation) {
    const queue = message.queue;
    const trackCount = queue?.tracks?.length || 0;
    queueTotalTracks = Number(queue?.total_track_count || trackCount);
    queueMaterializedTracks = Number(queue?.materialized_track_count || trackCount);
  }
  const event = inlinePipeline ? 'raw_collection_completed_inline' : 'raw_collection_enqueued';
  console.log(JSON.stringify({
    event,
    observed_at: observedAt,
    payload_chars: body.length,
    queue_total_tracks: queueTotalTracks,
    queue_materialized_tracks: queueMaterializedTracks,
  }));
  return {
    inline: inlinePipeline,
    message_version: Number(message.message_version || 0),
    observed_at: observedAt,
  };
}

export function resetRawCollectorSessionCacheForTests() {
  // WeakMap cannot be cleared; tests use fresh DB identities. This export gives
  // callers a stable seam without exposing cached credentials.
}

export default {
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(collectRawChannel(env));
  },
};
