import { buddyPlaybackConfig } from './buddy-playback.js';
import { recordBuddyFailure, recordBuddySuccess } from './buddy-health.js';
import { advanceBuddyPlaybackPipeline } from './buddy-playback-pipeline.js';

const BENIGN_SKIP_REASONS = new Set(['not-due', 'pipeline-busy', 'retry-not-due']);

function validateTask(body) {
  if (body?.message_type !== 'buddy-playback-stage'
      || Number(body?.message_version) !== 1) {
    throw new Error('unsupported buddy playback task');
  }
  return {
    scheduledAt: Number(body.scheduled_at) || Date.now(),
    observedAt: Number(body.observed_at) || Date.now(),
  };
}

async function enqueueNextStage(env, task) {
  if (!env?.BUDDY_PLAYBACK_QUEUE?.send) throw new Error('BUDDY_PLAYBACK_QUEUE binding is missing');
  await env.BUDDY_PLAYBACK_QUEUE.send({
    message_type: 'buddy-playback-stage',
    message_version: 1,
    scheduled_at: task.scheduledAt,
    observed_at: Date.now(),
  }, { contentType: 'json', delaySeconds: 1 });
}

export async function processBuddyPlaybackStage(env, body, dependencies = {}) {
  const task = validateTask(body);
  const run = dependencies.advance || advanceBuddyPlaybackPipeline;
  const result = await run(env, task.scheduledAt, task.observedAt, dependencies.pipeline || {});
  const config = buddyPlaybackConfig(env);

  if (result?.pending) {
    await enqueueNextStage(env, task);
    return { ...result, requeued: true };
  }
  if (result?.skipped) {
    const reason = String(result.reason || 'unknown');
    if (!BENIGN_SKIP_REASONS.has(reason)) {
      await recordBuddyFailure(env, config.alias, new Error(`Buddy playback skipped: ${reason}`), task.observedAt);
    }
    return result;
  }
  await recordBuddySuccess(env, config.alias, result, task.observedAt);
  return result;
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
      try {
        const result = await processBuddyPlaybackStage(env, message.body);
        console.log(JSON.stringify({ event: 'buddy_playback_stage_completed', ...result }));
        message.ack();
      } catch (error) {
        const config = buddyPlaybackConfig(env);
        await recordBuddyFailure(env, config.alias, error, Date.now()).catch(() => {});
        console.error(JSON.stringify({
          event: 'buddy_playback_stage_failed',
          error: String(error?.message || error).slice(0, 800),
        }));
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
