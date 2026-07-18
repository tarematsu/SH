import { sanitizeFailureDetail } from './collector-failure.js';
import {
  completeMinuteFactJob,
  failMinuteFactJob,
  releaseMinuteFactJobs,
} from './minute-facts-inbox.js';
import { parseMinuteDeriveTrigger } from './minute-derive-trigger.js';

export * from './minute-derive-trigger.js';

const MINUTE_DERIVE_STAGE_TYPE = 'minute-fact-derive-stage';
const MINUTE_DERIVE_STAGE_VERSION = 1;

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
  const parsed = options.parsedTrigger || parseMinuteDeriveTrigger(trigger);
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

function validateStagePayload(payload, payloadVersion = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid minute derive stage payload');
  }
  if (Number(payload.payload_version || payloadVersion || 0) !== 1) {
    throw new Error(`unsupported minute fact payload version: ${payload.payload_version || payloadVersion}`);
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

async function defaultWrite(env, payload) {
  if (payload?.rebuild) {
    const { saveReconstructedMinuteFactWithinBudget } = await import('./minute-facts-rebuild-store.js');
    return saveReconstructedMinuteFactWithinBudget(env, payload);
  }
  const { saveOptimizedMinuteFactWithinBudget } = await import('./minute-facts-fast-store.js');
  return saveOptimizedMinuteFactWithinBudget(env, payload);
}

async function attachOptionalStats(summary, env, stats) {
  if (!stats) return summary;
  try { Object.assign(summary, await stats(env)); } catch {}
  return summary;
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

function parseStage(body, expectedStage) {
  if (body?.message_type !== MINUTE_DERIVE_STAGE_TYPE
      || integer(body?.message_version) !== MINUTE_DERIVE_STAGE_VERSION
      || String(body?.stage || '') !== expectedStage) {
    const error = new Error(`invalid minute derive ${expectedStage} stage`);
    error.code = 'MINUTE_DERIVE_INVALID_TRIGGER';
    throw error;
  }
  const job = compactJob(body.job);
  if (job.id == null || job.channel_id == null || job.minute_at == null) {
    const error = new Error('invalid minute derive stage job');
    error.code = 'MINUTE_DERIVE_INVALID_TRIGGER';
    throw error;
  }
  return {
    job,
    payload: body.payload == null ? null : validateStagePayload(body.payload, job.payload_version),
    revision: body.revision || null,
    startedAt: integer(body.started_at) ?? Date.now(),
  };
}

async function enqueueStage(env, body, dependencies = {}) {
  const send = dependencies.sendStage
    || ((message) => env.MINUTE_DERIVE_QUEUE.send(message, { contentType: 'json' }));
  if (!dependencies.sendStage && !env?.MINUTE_DERIVE_QUEUE?.send) {
    throw new Error('MINUTE_DERIVE_QUEUE binding is missing');
  }
  await send({
    message_type: MINUTE_DERIVE_STAGE_TYPE,
    message_version: MINUTE_DERIVE_STAGE_VERSION,
    ...body,
  });
}

async function renewJobLease(env, job, dependencies = {}) {
  if (dependencies.renewLease) return dependencies.renewLease(env, job);
  if (!env?.MINUTE_DB) return;
  const now = (dependencies.now || Date.now)();
  const leaseMs = positiveInteger(env.DERIVE_LEASE_MS, 60_000, 10 * 60_000);
  await env.MINUTE_DB.prepare(`UPDATE sh_minute_fact_jobs
    SET lease_until=?,updated_at=? WHERE id=? AND status='processing'`)
    .bind(now + leaseMs, now, job.id)
    .run();
}

async function failureSummary(env, job, error, startedAt, dependencies = {}, retryMessage = true) {
  const nowFn = dependencies.now || Date.now;
  const maxAttempts = positiveInteger(env.DERIVE_MAX_ATTEMPTS, 8, 100);
  const delayMs = retryDelayMs(job.attempts);
  const fail = dependencies.fail || failMinuteFactJob;
  const result = await fail(env, job, error, {
    now: nowFn(),
    maxAttempts,
    retryDelayMs: delayMs,
  });
  return attachOptionalStats({
    event: 'minute_fact_derive_job',
    processed: 0,
    failed: 1,
    dead: result?.terminal ? 1 : 0,
    terminal: Boolean(result?.terminal),
    retry_delay_ms: delayMs,
    retry_message: retryMessage,
    job_id: Number(job.id),
    job_kind: job.job_kind || 'live',
    attempts: Number(job.attempts || 0),
    error: sanitizeFailureDetail(error?.message || error),
    duration_ms: Math.max(0, nowFn() - startedAt),
  }, env, dependencies.stats || null);
}

async function executeInline(env, job, payload, startedAt, dependencies = {}) {
  const nowFn = dependencies.now || Date.now;
  const timeoutMs = positiveInteger(env.DERIVE_JOB_TIMEOUT_MS, 18_000, 20_000);
  const complete = dependencies.complete || completeMinuteFactJob;
  try {
    const write = dependencies.write
      || (payload?.rebuild && dependencies.rebuildWrite)
      || (!payload?.rebuild && dependencies.liveWrite)
      || defaultWrite;
    await write(withDeriveTimeout(env, timeoutMs), payload);
    await complete(env, job.id, nowFn());
    return attachOptionalStats({
      event: 'minute_fact_derive_job',
      processed: 1,
      failed: 0,
      processed_live: payload.rebuild ? 0 : 1,
      processed_rebuild: payload.rebuild ? 1 : 0,
      job_id: Number(job.id),
      duration_ms: Math.max(0, nowFn() - startedAt),
    }, env, dependencies.stats || null);
  } catch (error) {
    return failureSummary(env, job, error, startedAt, dependencies, true);
  }
}

export async function processMinuteDeriveTrigger(env, body, dependencies = {}) {
  const trigger = parseMinuteDeriveTrigger(body);
  const nowFn = dependencies.now || Date.now;
  const startedAt = nowFn();
  const leaseMs = positiveInteger(env.DERIVE_LEASE_MS, 60_000, 10 * 60_000);
  const claim = dependencies.claim || claimMinuteDeriveJob;
  const job = await claim(env, trigger, { now: nowFn(), leaseMs, parsedTrigger: trigger });
  if (!job) {
    return { event: 'minute_fact_derive_job', processed: 0, failed: 0, skipped: true, reason: 'not-pending' };
  }

  let payload;
  try {
    payload = parseJobPayload(job);
  } catch (error) {
    return failureSummary(env, job, error, startedAt, dependencies, true);
  }

  if (env?.MINUTE_DERIVE_QUEUE?.send && dependencies.inline !== true) {
    try {
      await enqueueStage(env, {
        stage: 'write',
        job: compactJob(job),
        payload,
        started_at: startedAt,
      }, dependencies);
    } catch (error) {
      const release = dependencies.release || releaseMinuteFactJobs;
      await release(env, [job.id], { now: nowFn() }).catch(() => {});
      throw error;
    }
    return {
      event: 'minute_fact_derive_claimed',
      processed: 0,
      failed: 0,
      pending: true,
      job_id: Number(job.id),
      job_kind: job.job_kind || 'live',
    };
  }

  return executeInline(env, job, payload, startedAt, dependencies);
}

export async function processMinuteDeriveWriteStage(env, body, dependencies = {}) {
  const { job, payload, startedAt } = parseStage(body, 'write');
  if (!payload) throw new Error('minute derive write payload is missing');
  const timeoutMs = positiveInteger(env.DERIVE_JOB_TIMEOUT_MS, 18_000, 20_000);
  const customWrite = dependencies.write
    || (payload?.rebuild && dependencies.rebuildWrite)
    || (!payload?.rebuild && dependencies.liveWrite);
  try {
    if (!customWrite && dependencies.stageRevision !== false && !payload.rebuild) {
      const revisionStages = await import('./minute-revision-stages.js');
      if (revisionStages.shouldStageLiveRevision(env, payload)) {
        const revision = await revisionStages.prepareLiveRevisionStage(env, payload);
        if (revision.staged) {
          await renewJobLease(env, job, dependencies);
          await enqueueStage(env, {
            stage: 'revision-chunk',
            job,
            payload,
            revision,
            started_at: startedAt,
          }, dependencies);
          return {
            event: 'minute_fact_derive_revision_prepared',
            processed: 0,
            failed: 0,
            pending: true,
            job_id: Number(job.id),
            revision_id: Number(revision.revision_id),
            item_count: Number(revision.item_count),
          };
        }
      }
    }
    await (customWrite || defaultWrite)(withDeriveTimeout(env, timeoutMs), payload);
  } catch (error) {
    return failureSummary(env, job, error, startedAt, dependencies, false);
  }
  await enqueueStage(env, {
    stage: 'complete',
    job,
    started_at: startedAt,
  }, dependencies);
  return {
    event: 'minute_fact_derive_write',
    processed: 0,
    failed: 0,
    pending: true,
    processed_live: payload.rebuild ? 0 : 1,
    processed_rebuild: payload.rebuild ? 1 : 0,
    job_id: Number(job.id),
  };
}

export async function processMinuteDeriveRevisionChunkStage(env, body, dependencies = {}) {
  const { job, payload, revision, startedAt } = parseStage(body, 'revision-chunk');
  if (!payload || !revision) throw new Error('minute derive revision chunk payload is missing');
  try {
    const writeChunk = dependencies.writeRevisionChunk
      || (await import('./minute-revision-stages.js')).writeLiveRevisionChunk;
    const next = await writeChunk(env, payload, revision);
    await renewJobLease(env, job, dependencies);
    await enqueueStage(env, {
      stage: next.complete ? 'revision-complete' : 'revision-chunk',
      job,
      payload,
      revision: next,
      started_at: startedAt,
    }, dependencies);
    return {
      event: 'minute_fact_derive_revision_chunk',
      processed: 0,
      failed: 0,
      pending: true,
      job_id: Number(job.id),
      revision_id: Number(next.revision_id),
      cursor: Number(next.cursor),
      item_count: Number(next.item_count),
      chunk_tracks: Number(next.chunk_tracks || 0),
    };
  } catch (error) {
    return failureSummary(env, job, error, startedAt, dependencies, false);
  }
}

export async function processMinuteDeriveRevisionCompleteStage(env, body, dependencies = {}) {
  const { job, payload, revision, startedAt } = parseStage(body, 'revision-complete');
  if (!payload || !revision) throw new Error('minute derive revision completion payload is missing');
  try {
    const completeRevision = dependencies.completeRevision
      || (await import('./minute-revision-stages.js')).completeLiveRevisionStage;
    const completed = await completeRevision(env, payload, revision);
    await renewJobLease(env, job, dependencies);
    await enqueueStage(env, {
      stage: 'write',
      job,
      payload,
      started_at: startedAt,
    }, dependencies);
    return {
      event: 'minute_fact_derive_revision_completed',
      processed: 0,
      failed: 0,
      pending: true,
      job_id: Number(job.id),
      revision_id: Number(completed.revision_id),
      item_count: Number(completed.item_count),
    };
  } catch (error) {
    return failureSummary(env, job, error, startedAt, dependencies, false);
  }
}

export async function processMinuteDeriveCompleteStage(env, body, dependencies = {}) {
  const { job, startedAt } = parseStage(body, 'complete');
  const nowFn = dependencies.now || Date.now;
  const complete = dependencies.complete || completeMinuteFactJob;
  await complete(env, job.id, nowFn());
  return attachOptionalStats({
    event: 'minute_fact_derive_job',
    processed: 1,
    failed: 0,
    processed_live: job.job_kind === 'rebuild' ? 0 : 1,
    processed_rebuild: job.job_kind === 'rebuild' ? 1 : 0,
    job_id: Number(job.id),
    duration_ms: Math.max(0, nowFn() - startedAt),
  }, env, dependencies.stats || null);
}

export function processMinuteDeriveMessage(env, body, dependencies = {}) {
  if (body?.message_type === MINUTE_DERIVE_STAGE_TYPE) {
    if (body.stage === 'write') return processMinuteDeriveWriteStage(env, body, dependencies);
    if (body.stage === 'revision-chunk') return processMinuteDeriveRevisionChunkStage(env, body, dependencies);
    if (body.stage === 'revision-complete') return processMinuteDeriveRevisionCompleteStage(env, body, dependencies);
    if (body.stage === 'complete') return processMinuteDeriveCompleteStage(env, body, dependencies);
    const error = new Error(`invalid minute derive stage: ${body?.stage || 'missing'}`);
    error.code = 'MINUTE_DERIVE_INVALID_TRIGGER';
    throw error;
  }
  return processMinuteDeriveTrigger(env, body, dependencies);
}
