import { saveMinuteFactReadModels } from './minute-facts-read-model.js';

export function readModelNeedsHydration(readModel) {
  const tracks = readModel?.queue?.value?.tracks;
  return Array.isArray(tracks) && tracks.some((track) => (
    !track?.title || !track?.artist || !track?.album_name || !track?.thumbnail_url
  ));
}

async function deferReadModelHydration(env, body) {
  if (!env?.TRACK_METADATA_QUEUE?.send || !readModelNeedsHydration(body?.read_model)) return false;
  await env.TRACK_METADATA_QUEUE.send({
    message_type: 'stationhead-track-metadata',
    message_version: 1,
    task: 'read-model-hydration',
    job_id: body.job_id,
    observed_at: Number(body.observed_at) || null,
    read_model: body.read_model,
  }, { contentType: 'json' });
  return true;
}

export async function processReadModelMessage(env, body) {
  if (body?.message_type !== 'stationhead-read-model' || Number(body?.message_version) !== 1) {
    throw new Error('unsupported read model message');
  }
  if (await deferReadModelHydration(env, body)) {
    console.log(JSON.stringify({
      event: 'read_model_hydration_deferred',
      observed_at: Number(body.observed_at) || null,
    }));
    return { deferred: true };
  }
  await saveMinuteFactReadModels(env, body.read_model, body.job_id);
  console.log(JSON.stringify({
    event: 'read_model_updated',
    observed_at: Number(body.observed_at) || null,
  }));
  return { deferred: false };
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
      try {
        await processReadModelMessage(env, message.body);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'read_model_update_failed',
          error: String(error?.message || error).slice(0, 800),
        }));
        message.retry();
      }
    }
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
