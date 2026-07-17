import { saveCollectorStateAndClearFailure } from './collector-state.js';

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

export async function processIngestFinalizeTask(env, body, dependencies = {}) {
  if (!env?.DB) throw new Error('ingest finalize DB binding is missing');
  if (!env?.READ_MODEL_QUEUE?.send && !dependencies.sendReadModel) {
    throw new Error('READ_MODEL_QUEUE binding is missing');
  }
  const { state, readModel } = validateFinalizeTask(body);
  const save = dependencies.saveCollectorState || saveCollectorStateAndClearFailure;
  await save(env, state, {
    lastRunAt: state.lastRunAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: null,
    tokenExpiresAt: state.tokenExpiresAt || null,
  });
  const send = dependencies.sendReadModel
    || ((message) => env.READ_MODEL_QUEUE.send(message, { contentType: 'json' }));
  await send(readModel);
  return {
    event: 'ingest_finalize_completed',
    observed_at: Number(body.observed_at) || null,
    channel_id: Number(body.channel_id) || null,
  };
}
