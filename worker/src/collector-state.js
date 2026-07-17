import { jwtExpiryMs, normalizeBearer } from './shared.js';

function collectorState(value, persistCredentials = true) {
  Object.defineProperties(value, {
    persistCredentials: {
      value: persistCredentials,
      enumerable: false,
      writable: true,
    },
    clearFailureOnSuccess: {
      value: Boolean(value.lastError),
      enumerable: false,
      writable: true,
    },
  });
  return value;
}

export function collectorStateFromAuthState(authState, env = {}) {
  const authToken = normalizeBearer(authState?.authToken || env.STATIONHEAD_AUTH_TOKEN || env.SH_AUTH_TOKEN);
  const deviceUid = String(authState?.deviceUid || env.STATIONHEAD_DEVICE_UID || env.SH_DEVICE_UID || '').trim();
  if (!authToken || !deviceUid) {
    throw new Error('Stationhead session is missing. Set the SH_AUTH_TOKEN and SH_DEVICE_UID Worker secrets.');
  }
  return collectorState({
    authToken,
    deviceUid,
    tokenExpiresAt: Number(authState?.tokenExpiresAt || 0) || jwtExpiryMs(authToken),
    lastRunAt: Number(authState?.collectorLastRunAt || 0),
    lastSuccessAt: Number(authState?.collectorLastSuccessAt || 0),
    lastError: authState?.collectorLastError || null,
    channelId: Number(authState?.collectorChannelId || 0) || null,
    stationId: Number(authState?.collectorStationId || 0) || null,
  }, env.__shPersistCollectorCredentials !== false);
}

export async function loadCollectorState(env) {
  if (env.__shAuthState) {
    return collectorStateFromAuthState(env.__shAuthState, env);
  }

  const row = await env.DB.prepare(`
    SELECT auth_token, device_uid, token_expires_at, last_run_at, last_success_at,
           last_error, last_channel_id, last_station_id, updated_at
    FROM sh_worker_collector_state
    WHERE id = 'stationhead'
  `).first();

  const authToken = normalizeBearer(row?.auth_token || env.STATIONHEAD_AUTH_TOKEN || env.SH_AUTH_TOKEN);
  const deviceUid = String(row?.device_uid || env.STATIONHEAD_DEVICE_UID || env.SH_DEVICE_UID || '').trim();

  if (!authToken || !deviceUid) {
    throw new Error('Stationhead session is missing. Set the SH_AUTH_TOKEN and SH_DEVICE_UID Worker secrets.');
  }

  return collectorState({
    authToken,
    deviceUid,
    tokenExpiresAt: Number(row?.token_expires_at || 0) || jwtExpiryMs(authToken),
    lastRunAt: Number(row?.last_run_at || 0),
    lastSuccessAt: Number(row?.last_success_at || 0),
    lastError: row?.last_error || null,
    channelId: Number(row?.last_channel_id || 0) || null,
    stationId: Number(row?.last_station_id || 0) || null,
  });
}

export async function saveCollectorState(env, state, patch = {}) {
  Object.assign(state, patch);
  await collectorStateStatement(env.DB, state).run();
}

function collectorStateStatement(db, state) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO sh_worker_collector_state (
      id, auth_token, device_uid, token_expires_at, last_run_at, last_success_at,
      last_error, last_channel_id, last_station_id, updated_at
    ) VALUES ('stationhead', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      auth_token=excluded.auth_token,
      device_uid=excluded.device_uid,
      token_expires_at=excluded.token_expires_at,
      last_run_at=excluded.last_run_at,
      last_success_at=excluded.last_success_at,
      last_error=excluded.last_error,
      last_channel_id=excluded.last_channel_id,
      last_station_id=excluded.last_station_id,
      updated_at=excluded.updated_at
  `).bind(
    state.authToken,
    state.deviceUid,
    state.tokenExpiresAt || jwtExpiryMs(state.authToken) || null,
    state.lastRunAt || null,
    state.lastSuccessAt || null,
    state.lastError || null,
    state.channelId || null,
    state.stationId || null,
    now,
  );
}

function collectorProgressStatement(db, state) {
  return db.prepare(`UPDATE sh_worker_collector_state SET
      last_run_at=?,last_success_at=?,last_error=?,
      last_channel_id=?,last_station_id=?,updated_at=?
    WHERE id='stationhead'`)
    .bind(
      state.lastRunAt || null,
      state.lastSuccessAt || null,
      state.lastError || null,
      state.channelId || null,
      state.stationId || null,
      Date.now(),
    );
}

function successfulCollectorStateStatement(db, state) {
  return state.persistCredentials === false
    ? collectorProgressStatement(db, state)
    : collectorStateStatement(db, state);
}

async function saveSuccessfulCollectorState(db, state) {
  const result = await successfulCollectorStateStatement(db, state).run();
  if (state.persistCredentials === false && Number(result?.meta?.changes || 0) === 0) {
    await collectorStateStatement(db, state).run();
  }
}

async function clearFailureBestEffort(db) {
  try {
    await db.prepare('DELETE FROM sh_collector_failure_state WHERE id=?')
      .bind('stationhead').run();
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'collector_failure_clear_failed',
      error: String(error?.message || error).slice(0, 500),
    }));
  }
}

// Clean ticks persist only collector progress. A tick following a recorded
// collector error batches the state recovery and incident cleanup so the old
// failure remains visible until the successful state is durable.
export async function saveCollectorStateAndClearFailure(env, state, patch = {}) {
  Object.assign(state, patch);
  if (state.clearFailureOnSuccess !== true) {
    await saveSuccessfulCollectorState(env.DB, state);
    return;
  }
  if (typeof env?.DB?.batch !== 'function') {
    await saveSuccessfulCollectorState(env.DB, state);
    await clearFailureBestEffort(env.DB);
    return;
  }
  try {
    const results = await env.DB.batch([
      successfulCollectorStateStatement(env.DB, state),
      env.DB.prepare('DELETE FROM sh_collector_failure_state WHERE id=?').bind('stationhead'),
    ]);
    if (state.persistCredentials === false
        && Array.isArray(results)
        && results[0]
        && Number(results[0]?.meta?.changes || 0) === 0) {
      await collectorStateStatement(env.DB, state).run();
    }
  } catch (error) {
    // Preserve the old success semantics if only the best-effort incident
    // cleanup failed: the collector state must still be committed.
    await saveSuccessfulCollectorState(env.DB, state);
    await clearFailureBestEffort(env.DB);
  }
}