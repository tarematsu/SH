import { saveMinuteFactReadModels } from './minute-facts-read-model.js';

const JSON_QUEUE_SEND_OPTIONS = { contentType: 'json' };

export function readModelNeedsHydration(readModel) {
  const tracks = readModel?.queue?.value?.tracks;
  if (!Array.isArray(tracks)) return false;
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (!track?.title || !track?.artist || !track?.album_name || !track?.thumbnail_url) return true;
  }
  return false;
}

export async function processReadModelMessage(env, body) {
  if (body?.message_type !== 'stationhead-read-model' || Number(body?.message_version) !== 1) {
    throw new Error('unsupported read model message');
  }
  const observedAt = Number(body.observed_at) || null;
  const readModel = body.read_model;
  const metadataQueue = env?.TRACK_METADATA_QUEUE;
  if (metadataQueue?.send && readModelNeedsHydration(readModel)) {
    await metadataQueue.send({
      message_type: 'stationhead-track-metadata',
      message_version: 1,
      task: 'read-model-hydration',
      job_id: body.job_id,
      observed_at: observedAt,
      read_model: readModel,
    }, JSON_QUEUE_SEND_OPTIONS);
    console.log(JSON.stringify({
      event: 'read_model_hydration_deferred',
      observed_at: observedAt,
    }));
    return { deferred: true };
  }
  await saveMinuteFactReadModels(env, readModel, body.job_id);
  console.log(JSON.stringify({
    event: 'read_model_updated',
    observed_at: observedAt,
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
