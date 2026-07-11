import { sanitizeFailureDetail } from './collector-failure.js';
import { saveOptimizedMinuteFactWithinBudget } from './minute-facts-fast-store.js';
import { saveReconstructedMinuteFactWithinBudget } from './minute-facts-rebuild-store.js';
import {
  claimMinuteFactJobs,
  completeMinuteFactJob,
  failMinuteFactJob,
  minuteFactInboxStats,
} from './minute-facts-inbox.js';

export const MINUTE_FACT_DERIVE_CRON = '*/2 * * * *';

const DEFAULT_MAX_JOBS = 8;
const DEFAULT_JOB_TIMEOUT_MS = 18_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RUN_BUDGET_MS = 50_000;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export function deriveConfig(env = {}) {
  return {
    maxJobs: positiveInteger(env.DERIVE_MAX_JOBS, DEFAULT_MAX_JOBS, 20),
    jobTimeoutMs: positiveInteger(env.DERIVE_JOB_TIMEOUT_MS, DEFAULT_JOB_TIMEOUT_MS, 20_000),
    leaseMs: positiveInteger(env.DERIVE_LEASE_MS, DEFAULT_LEASE_MS, 10 * 60_000),
    maxAttempts: positiveInteger(env.DERIVE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 100),
    runBudgetMs: positiveInteger(env.DERIVE_RUN_BUDGET_MS, DEFAULT_RUN_BUDGET_MS, 55_000),
  };
}

export function minuteFactRetryDelayMs(attempts) {
  const exponent = Math.max(0, Math.min(6, positiveInteger(attempts, 1) - 1));
  return Math.min(60 * 60_000, 60_000 * (2 ** exponent));
}

function withDeriveTimeout(env, timeoutMs) {
  return new Proxy(env || {}, {
    get(target, property, receiver) {
      if (property === 'MINUTE_FACT_TIMEOUT_MS') return timeoutMs;
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === 'MINUTE_FACT_TIMEOUT_MS' || Reflect.has(target, property);
    },
  });
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

export async function runMinuteFactDeriveCron(env, dependencies = {}) {
  if (!env?.DB) throw new Error('minute fact derive DB binding is missing');
  if (!env?.FACTS_DB) throw new Error('minute fact derive FACTS_DB binding is missing');

  const config = deriveConfig(env);
  const nowFn = dependencies.now || Date.now;
  const claim = dependencies.claim || claimMinuteFactJobs;
  const complete = dependencies.complete || completeMinuteFactJob;
  const fail = dependencies.fail || failMinuteFactJob;
  const liveWrite = dependencies.liveWrite || saveOptimizedMinuteFactWithinBudget;
  const rebuildWrite = dependencies.rebuildWrite || saveReconstructedMinuteFactWithinBudget;
  const write = dependencies.write || ((activeEnv, payload) => (
    payload?.rebuild ? rebuildWrite(activeEnv, payload) : liveWrite(activeEnv, payload)
  ));
  const stats = dependencies.stats || minuteFactInboxStats;
  const startedAt = nowFn();
  const deadlineAt = startedAt + config.runBudgetMs;
  const summary = {
    event: 'minute_fact_derive_summary',
    processed: 0,
    processed_live: 0,
    processed_rebuild: 0,
    failed: 0,
    dead: 0,
    skipped_budget: 0,
  };

  while (summary.processed + summary.failed < config.maxJobs) {
    if (nowFn() >= deadlineAt - 1_000) {
      summary.skipped_budget += 1;
      break;
    }

    const jobs = await claim(env, {
      now: nowFn(),
      limit: 1,
      leaseMs: config.leaseMs,
    });
    const job = jobs?.[0];
    if (!job) break;

    try {
      const payload = parseJobPayload(job);
      await write(withDeriveTimeout(env, config.jobTimeoutMs), payload);
      await complete(env, job.id, nowFn());
      summary.processed += 1;
      if (payload.rebuild) summary.processed_rebuild += 1;
      else summary.processed_live += 1;
    } catch (error) {
      const result = await fail(env, job, error, {
        now: nowFn(),
        maxAttempts: config.maxAttempts,
        retryDelayMs: minuteFactRetryDelayMs(job.attempts),
      });
      summary.failed += 1;
      if (result?.terminal) summary.dead += 1;
      console.warn(JSON.stringify({
        event: 'minute_fact_job_failed',
        job_id: Number(job.id),
        job_kind: job.job_kind || 'live',
        attempts: Number(job.attempts || 0),
        terminal: Boolean(result?.terminal),
        error: sanitizeFailureDetail(error?.message || error),
      }));
    }
  }

  try {
    Object.assign(summary, await stats(env));
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'minute_fact_inbox_stats_failed',
      error: sanitizeFailureDetail(error?.message || error),
    }));
  }

  summary.duration_ms = Math.max(0, nowFn() - startedAt);
  console.log(JSON.stringify(summary));
  return summary;
}
