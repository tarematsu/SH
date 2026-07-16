import { sanitizeFailureDetail } from './collector-failure.js';
import { saveOptimizedMinuteFactWithinBudget } from './minute-facts-fast-store.js';
import { saveReconstructedMinuteFactWithinBudget } from './minute-facts-rebuild-store.js';
import {
  completeMinuteFactJob,
  failMinuteFactJob,
  minuteFactInboxStats,
} from './minute-facts-inbox.js';
import { parseMinuteDeriveTrigger } from './minute-derive-trigger.js';

export * from './minute-derive-trigger.js';

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export async function claimMinuteDeriveJob(env, trigger, options = {}) {
  if (!env?.MINUTE_DB) throw new Error('minute derive MINUTE_DB binding is missing');
  const parsed = parseMinuteDeriveTrigger(trigger);
  const now = integer(options.now) ?? Date.now();
  const leaseMs = positiveInteger(options.leaseMs, 60_000, 10 * 60_000);
  const result = await env.MINUTE_DB.prepare(`UPDATE sh_minute_fact_jobs SET
      status='processing',attempts=attempts+1,lease_until=?,updated_at=?
    WHERE channel_id=? AND minute_at=? AND (
      (status='pending' AND next_attempt_at<=?)
      OR (status='processing' AND COALESCE(lease_until,0)<?)
    )
    RETURNING *`)
    .bind(now + leaseMs, now, parsed.channel_id, parsed.minute_at, now, now)
    .all();
  return result.results?.[0] || null;
}

function parseJobPayload(job) {
  let payload;
  try {
    payload = JSON.parse(String(job?.payload_json || ''));
  } catch (error) {
    throw new Error(`invalid minute fact job payload: ${error?.message || error}`);
  }
  if (Number(payload?.payload_version || job?.payload_version || 0) !== 1) {
    throw new Error(`unsupported minute fact payload version: ${payload?.payload_version || job?.payload_version}`);
  }
  return payload;
}

function retryDelayMs(attempts) {
  const exponent = Math.max(0, Math.min(6, positiveInteger(attempts, 1) - 1));
  return Math.min(60 * 60_000, 60_000 * (2 ** exponent));
}

function withDeriveTimeout(env, timeoutMs) {
  const active = Object.create(env || null);
  Object.defineProperty(active, 'MINUTE_FACT_TIMEOUT_MS', {
    value: timeoutMs,
    enumerable: true,
    configurable: true,
  });
  return active;
}

export async function processMinuteDeriveTrigger(env, body, dependencies = {}) {
  const trigger = parseMinuteDeriveTrigger(body);
  const nowFn = dependencies.now || Date.now;
  const startedAt = nowFn();
  const leaseMs = positiveInteger(env.DERIVE_LEASE_MS, 60_000, 10 * 60_000);
  const timeoutMs = positiveInteger(env.DERIVE_JOB_TIMEOUT_MS, 18_000, 20_000);
  const maxAttempts = positiveInteger(env.DERIVE_MAX_ATTEMPTS, 8, 100);
  const claim = dependencies.claim || claimMinuteDeriveJob;
  const complete = dependencies.complete || completeMinuteFactJob;
  const fail = dependencies.fail || failMinuteFactJob;
  const liveWrite = dependencies.liveWrite || saveOptimizedMinuteFactWithinBudget;
  const rebuildWrite = dependencies.rebuildWrite || saveReconstructedMinuteFactWithinBudget;
  const stats = dependencies.stats || minuteFactInboxStats;
  const job = await claim(env, trigger, { now: nowFn(), leaseMs });
  if (!job) {
    return { event: 'minute_fact_derive_job', processed: 0, failed: 0, skipped: true, reason: 'not-pending' };
  }

  try {
    const payload = parseJobPayload(job);
    const write = dependencies.write || ((activeEnv, activePayload) => (
      activePayload?.rebuild ? rebuildWrite(activeEnv, activePayload) : liveWrite(activeEnv, activePayload)
    ));
    await write(withDeriveTimeout(env, timeoutMs), payload);
    await complete(env, job.id, nowFn());
    const summary = {
      event: 'minute_fact_derive_job',
      processed: 1,
      failed: 0,
      processed_live: payload.rebuild ? 0 : 1,
      processed_rebuild: payload.rebuild ? 1 : 0,
      job_id: Number(job.id),
      duration_ms: Math.max(0, nowFn() - startedAt),
    };
    try { Object.assign(summary, await stats(env)); } catch {}
    return summary;
  } catch (error) {
    const delayMs = retryDelayMs(job.attempts);
    const result = await fail(env, job, error, {
      now: nowFn(),
      maxAttempts,
      retryDelayMs: delayMs,
    });
    const summary = {
      event: 'minute_fact_derive_job',
      processed: 0,
      failed: 1,
      dead: result?.terminal ? 1 : 0,
      terminal: Boolean(result?.terminal),
      retry_delay_ms: delayMs,
      job_id: Number(job.id),
      job_kind: job.job_kind || 'live',
      attempts: Number(job.attempts || 0),
      error: sanitizeFailureDetail(error?.message || error),
      duration_ms: Math.max(0, nowFn() - startedAt),
    };
    try { Object.assign(summary, await stats(env)); } catch {}
    return summary;
  }
}
