import { buddyPlaybackConfig } from './buddy-playback.js';
import { recordBuddyFailure, recordBuddySuccess } from './buddy-health.js';
import { advanceBuddyPlaybackPipeline } from './buddy-playback-pipeline.js';

const BENIGN_SKIP_REASONS = new Set(['not-due', 'pipeline-busy', 'retry-not-due']);
const PIPELINE_STAGES = new Set(['fetch', 'parse', 'parse-store', 'metadata', 'commit']);
const NEXT_STAGE_OPTIONS = Object.freeze({ contentType: 'json', delaySeconds: 1 });
const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });
const EMPTY_DEPENDENCIES = Object.freeze({});

function validTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Date.now();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function validateTask(body) {
  if (body?.message_type !== 'buddy-playback-stage'
      || Number(body?.message_version) !== 1) {
    throw new Error('unsupported buddy playback task');
  }
  const expectedStage = typeof body.expected_stage === 'string'
    ? body.expected_stage
    : String(body.expected_stage || '');
  const cycleAt = Number(body.cycle_at);
  return {
    scheduledAt: validTimestamp(body.scheduled_at),
    observedAt: validTimestamp(body.observed_at),
    expectedStage: PIPELINE_STAGES.has(expectedStage) ? expectedStage : null,
    cycleAt: Number.isFinite(cycleAt) ? cycleAt : null,
    preparedParse: body.prepared_parse && typeof body.prepared_parse === 'object'
      ? body.prepared_parse
      : null,
  };
}

async function enqueueNextStage(env, task, result = null) {
  if (!env?.BUDDY_PLAYBACK_QUEUE?.send) throw new Error('BUDDY_PLAYBACK_QUEUE binding is missing');
  const stage = result?.stage;
  const cycleAt = Number(result?.cycle_at);
  const message = {
    message_type: 'buddy-playback-stage',
    message_version: 1,
    scheduled_at: task.scheduledAt,
    observed_at: Date.now(),
  };
  if (PIPELINE_STAGES.has(stage)) message.expected_stage = stage;
  if (Number.isFinite(cycleAt)) message.cycle_at = cycleAt;
  if (result?.prepared_parse) message.prepared_parse = result.prepared_parse;
  await env.BUDDY_PLAYBACK_QUEUE.send(message, NEXT_STAGE_OPTIONS);
}

function pipelineDependencies(task, dependencies) {
  const active = dependencies.pipeline ? { ...dependencies.pipeline } : {};
  if (task.expectedStage) active.expectedStage = task.expectedStage;
  if (task.cycleAt !== null) active.cycleAt = task.cycleAt;
  if (task.preparedParse) active.preparedParse = task.preparedParse;
  return active;
}

export async function processBuddyPlaybackStage(env, body, dependencies = EMPTY_DEPENDENCIES) {
  const task = validateTask(body);
  const run = dependencies.advance || advanceBuddyPlaybackPipeline;
  const result = await run(
    env,
    task.scheduledAt,
    task.observedAt,
    pipelineDependencies(task, dependencies),
  );

  if (result?.pending) {
    await enqueueNextStage(env, task, result);
    return { ...result, requeued: true };
  }
  if (result?.skipped) {
    const reason = typeof result.reason === 'string' ? result.reason : String(result.reason || 'unknown');
    if (!BENIGN_SKIP_REASONS.has(reason)) {
      const config = buddyPlaybackConfig(env);
      await recordBuddyFailure(env, config.alias, new Error(`Buddy playback skipped: ${reason}`), task.observedAt);
    }
    return result;
  }
  const config = buddyPlaybackConfig(env);
  await recordBuddySuccess(env, config.alias, result, task.observedAt);
  return result;
}

function logBuddyPlaybackResult(result) {
  console.log(JSON.stringify({
    event: 'buddy_playback_stage_completed',
    skipped: result?.skipped === true,
    reason: result?.reason,
    pending: result?.pending === true,
    stage: result?.stage,
    cycle_at: result?.cycle_at,
    checked_at: result?.checked_at,
    requeued: result?.requeued === true,
    tracks: result?.tracks,
    metadata_remaining: result?.metadata_remaining,
    changed: result?.changed,
  }));
}

export async function runBuddyPlaybackQueue(batch, env, dependencies = EMPTY_DEPENDENCIES) {
  const messages = batch?.messages;
  if (!messages?.length) return;
  const message = messages[0];
  try {
    const result = await processBuddyPlaybackStage(env, message.body, dependencies);
    logBuddyPlaybackResult(result);
    message.ack();
  } catch (error) {
    const config = buddyPlaybackConfig(env);
    await recordBuddyFailure(env, config.alias, error, Date.now()).catch(() => {});
    console.error(JSON.stringify({
      event: 'buddy_playback_stage_failed',
      error: String(error?.message || error).slice(0, 800),
    }));
    message.retry(RETRY_60_SECONDS);
  }
}

export default {
  queue: runBuddyPlaybackQueue,
  fetch() {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
