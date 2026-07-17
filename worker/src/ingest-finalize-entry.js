function validateFinalizeTask(body) {
  if (body?.message_type !== 'stationhead-ingest-finalize'
      || Number(body?.message_version) !== 1
      || !body.collector_state
      || !body.read_model) {
    throw new Error('unsupported ingest finalize task');
  }
  const state = body.collector_state;
  if (!state.authToken || !state.deviceUid) throw new Error('ingest finalize collector state is invalid');
  return { state, readModel: body.read_model };
}

async function saveFinalizedCollectorState(env, state) {
  const persistCredentials = state.persistCredentials !== false ? 1 : 0;
  const result = await env.DB.prepare(`INSERT INTO sh_worker_collector_state(
      id,auth_token,device_uid,token_expires_at,last_run_at,last_success_at,
      last_error,last_channel_id,last_station_id,updated_at
    ) VALUES('stationhead',?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      auth_token=CASE WHEN ?=1 THEN excluded.auth_token ELSE sh_worker_collector_state.auth_token END,
      device_uid=CASE WHEN ?=1 THEN excluded.device_uid ELSE sh_worker_collector_state.device_uid END,
      token_expires_at=CASE WHEN ?=1 THEN excluded.token_expires_at ELSE sh_worker_collector_state.token_expires_at END,
      last_run_at=excluded.last_run_at,last_success_at=excluded.last_success_at,
      last_error=NULL,last_channel_id=excluded.last_channel_id,
      last_station_id=excluded.last_station_id,updated_at=excluded.updated_at
    WHERE excluded.last_run_at>=COALESCE(sh_worker_collector_state.last_run_at,0)`)
    .bind(
      state.authToken,
      state.deviceUid,
      Number(state.tokenExpiresAt) || null,
      Number(state.lastRunAt) || null,
      Number(state.lastSuccessAt) || null,
      null,
      Number(state.channelId) || null,
      Number(state.stationId) || null,
      Date.now(),
      persistCredentials,
      persistCredentials,
      persistCredentials,
    )
    .run();
  const accepted = Number(result?.meta?.changes || 0) > 0;
  if (accepted && state.clearFailureOnSuccess === true) {
    await env.DB.prepare('DELETE FROM sh_collector_failure_state WHERE id=?')
      .bind('stationhead').run();
  }
  return { accepted };
}

export async function processIngestFinalizeTask(env, body, dependencies = {}) {
  if (!env?.DB) throw new Error('ingest finalize DB binding is missing');
  if (!env?.READ_MODEL_QUEUE?.send && !dependencies.sendReadModel) {
    throw new Error('READ_MODEL_QUEUE binding is missing');
  }
  const { state, readModel } = validateFinalizeTask(body);
  const save = dependencies.saveCollectorState || saveFinalizedCollectorState;
  const saved = await save(env, state);
  const send = dependencies.sendReadModel
    || ((message) => env.READ_MODEL_QUEUE.send(message, { contentType: 'json' }));
  await send(readModel);
  return {
    event: 'ingest_finalize_completed',
    observed_at: Number(body.observed_at) || null,
    channel_id: Number(body.channel_id) || null,
    state_accepted: saved?.accepted !== false,
  };
}
