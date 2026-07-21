import { claimMinuteDeriveJob } from './minute-derive-queue.js';
import { releaseMinuteFactJobs } from './minute-facts-inbox.js';
import { parseMinuteDeriveTrigger } from './minute-derive-trigger.js';

const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function compactJob(job) {
  return {
    id: integer(job?.id),
    channel_id: integer(job?.channel_id),
    minute_at: integer(job?.minute_at),
    payload_version: integer(job?.payload_version) ?? 1,
    job_kind: String(job?.job_kind || 'live'),
    attempts: positiveInteger(job?.attempts, 1, 1000),
  };
}

async function sendWriteStage(env, body, dependencies = {}) {
  if (dependencies.sendStage) return dependencies.sendStage(body);
  const queue = env?.MINUTE_LIVE_DERIVE_QUEUE || env?.MINUTE_DERIVE_QUEUE;
  if (!queue?.send) throw new Error('minute live derive Queue binding is missing');
  return queue.send(body, JSON_QUEUE_SEND_OPTIONS);
}

export async function processBudgetedLiveTriggerMessage(env, body, dependencies = {}) {
  const trigger = parseMinuteDeriveTrigger(body);
  const now = (dependencies.now || Date.now)();
  const leaseMs = positiveInteger(env?.DERIVE_LEASE_MS, 60_000, 10 * 60_000);
  const claim = dependencies.claim || claimMinuteDeriveJob;
  const job = await claim(env, trigger, { now, leaseMs, parsedTrigger: trigger });
  if (!job) {
    return { skipped: true, reason: 'not-pending', pending: false };
  }
  try {
    await sendWriteStage(env, {
      message_type: 'minute-fact-derive-stage',
      message_version: 1,
      stage: 'write',
      job: compactJob(job),
      started_at: now,
      durable_payload: true,
    }, dependencies);
  } catch (error) {
    const release = dependencies.release || releaseMinuteFactJobs;
    await release(env, [job.id], { now }).catch(() => {});
    throw error;
  }
  return {
    skipped: false,
    pending: true,
    job_id: integer(job.id),
  };
}

export async function processBudgetedLiveTriggerBatch(batch, env, dependencies = {}) {
  for (const message of batch?.messages || []) {
    try {
      await processBudgetedLiveTriggerMessage(env, message.body, dependencies);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        event: 'minute_live_trigger_budget_failed',
        error: String(error?.message || error).slice(0, 800),
      }));
      if (error?.code === 'MINUTE_DERIVE_INVALID_TRIGGER') message.ack();
      else message.retry(RETRY_60_SECONDS);
    }
  }
}

export default {
  queue: processBudgetedLiveTriggerBatch,
};
