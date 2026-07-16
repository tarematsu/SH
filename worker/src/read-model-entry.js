import { saveMinuteFactReadModels } from './minute-facts-read-model.js';

export async function processReadModelMessage(env, body) {
  if (body?.message_type !== 'stationhead-read-model' || Number(body?.message_version) !== 1) {
    throw new Error('unsupported read model message');
  }
  await saveMinuteFactReadModels(env, body.read_model, body.job_id);
  console.log(JSON.stringify({
    event: 'read_model_updated',
    observed_at: Number(body.observed_at) || null,
  }));
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
