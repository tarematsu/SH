import { withAppleMusicFreeRuntime } from '../../site/functions/lib/apple-music-d1-pruner.js';
import { withMinuteD1WriteThrottling } from './minute-d1-write-throttle.js';
import {
  processMinuteDeriveMessage,
} from './minute-derive-router.js';

export const LIVE_DERIVE_QUEUE_NAME = 'stationhead-minute-live-derive';
export const REBUILD_DERIVE_QUEUE_NAME = 'stationhead-minute-derive';

const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });
const SUCCESS_LOG_SAMPLE_MODULUS = 16;
const LIVE_REVISION_CHUNK_TRACKS = 2;
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json', delaySeconds: 1 });
const SOURCE_PAYLOAD_ERROR = /queue revision \d+ source payload is unavailable or incomplete/i;
const activeDeriveEnvs = new WeakMap();

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function shouldLogMinuteDeriveResult(result) {
  if (Number(result?.failed || 0) > 0 || result?.terminal === true || result?.reason) return true;
  const identity = Number(result?.job_id ?? result?.revision_id);
  if (!Number.isFinite(identity)) return false;
  return Math.abs(Math.trunc(identity)) % SUCCESS_LOG_SAMPLE_MODULUS === 0;
}

function logMinuteDeriveResult(result, queueName = null) {
  if (!shouldLogMinuteDeriveResult(result)) return;
  console.log(JSON.stringify({
    event: result?.event || 'minute_derive_completed',
    processed: result?.processed ?? 0,
    failed: result?.failed ?? 0,
    pending: result?.pending === true,
    terminal: result?.terminal === true,
    job_id: result?.job_id ?? null,
    revision_id: result?.revision_id ?? null,
    derive_queue: queueName,
  }));
}

function scopedDeriveEnv(base, continuation, chunkTracks = null) {
  const active = Object.create(base || null);
  if (continuation) {
    Object.defineProperty(active, 'MINUTE_DERIVE_QUEUE', {
      value: continuation,
      enumerable: false,
      configurable: true,
    });
  }
  if (chunkTracks != null) {
    Object.defineProperty(active, 'DERIVE_REVISION_CHUNK_TRACKS', {
      value: chunkTracks,
      enumerable: false,
      configurable: true,
    });
  }
  return active;
}

function deriveEnvironmentSet(env) {
  const cached = activeDeriveEnvs.get(env);
  if (cached) return cached;
  const base = withMinuteD1WriteThrottling(withAppleMusicFreeRuntime(env));
  const rebuildQueue = env?.MINUTE_DERIVE_QUEUE;
  const liveQueue = env?.MINUTE_LIVE_DERIVE_QUEUE || rebuildQueue;
  const environments = {
    live: scopedDeriveEnv(base, liveQueue, LIVE_REVISION_CHUNK_TRACKS),
    rebuild: scopedDeriveEnv(base, rebuildQueue),
    fallback: scopedDeriveEnv(base, liveQueue),
  };
  activeDeriveEnvs.set(env, environments);
  return environments;
}

export function activeDeriveEnv(batch, env) {
  const sourceQueue = String(batch?.queue || '');
  const environments = deriveEnvironmentSet(env);
  if (sourceQueue === LIVE_DERIVE_QUEUE_NAME) return environments.live;
  if (sourceQueue === REBUILD_DERIVE_QUEUE_NAME) return environments.rebuild;
  return environments.fallback;
}

function importInProgress(error) {
  return /currently processing a long-running import/i.test(String(error?.message || error));
}

function sourcePayloadUnavailable(error) {
  return SOURCE_PAYLOAD_ERROR.test(String(error?.message || error));
}

export async function refreshSparseRevisionContinuation(env, body) {
  const revisionId = integer(body?.revision?.revision_id);
  const db = env?.MINUTE_DB;
  const queue = env?.MINUTE_DERIVE_QUEUE;
  if (revisionId == null || !db?.prepare || !queue?.send) return false;
  const row = await db.prepare(`SELECT source_job_id,source_visible_count,item_count,
      materialized_item_count,coverage_complete
    FROM sh_queue_revisions WHERE id=? LIMIT 1`).bind(revisionId).first();
  const sourceJobId = integer(row?.source_job_id);
  const visibleItemCount = integer(row?.source_visible_count);
  if (sourceJobId == null || visibleItemCount == null) return false;
  const current = body.revision || {};
  const totalItemCount = Math.max(
    visibleItemCount,
    integer(row?.item_count) ?? integer(current.total_item_count) ?? visibleItemCount,
  );
  const materializedItemCount = Math.max(0, integer(row?.materialized_item_count) ?? 0);
  const changed = sourceJobId !== integer(current.source_job_id)
    || visibleItemCount !== integer(current.visible_item_count)
    || materializedItemCount !== integer(current.materialized_item_count);
  if (!changed && materializedItemCount < visibleItemCount) return false;
  await queue.send({
    ...body,
    revision: {
      ...current,
      source_job_id: sourceJobId,
      visible_item_count: visibleItemCount,
      total_item_count: totalItemCount,
      materialized_item_count: materializedItemCount,
      coverage_complete: Number(row?.coverage_complete || 0) === 1,
    },
  }, JSON_QUEUE_SEND_OPTIONS);
  return true;
}

async function processOneMinuteDeriveMessage(message, activeEnv, queueName, dependencies = {}) {
  const processMessage = dependencies.processMessage || processMinuteDeriveMessage;
  const refreshContinuation = dependencies.refreshContinuation || refreshSparseRevisionContinuation;
  try {
    const result = await processMessage(activeEnv, message.body);
    logMinuteDeriveResult(result, queueName);
    if (result?.failed && !result.terminal && result.retry_message !== false) {
      const retryDelayMs = result.retry_delay_ms;
      const delaySeconds = typeof retryDelayMs === 'number' && Number.isFinite(retryDelayMs)
        ? Math.max(1, Math.ceil(retryDelayMs / 1000))
        : 60;
      message.retry(delaySeconds === 60 ? RETRY_60_SECONDS : { delaySeconds });
    } else {
      message.ack();
    }
  } catch (error) {
    if (sourcePayloadUnavailable(error)
        && await refreshContinuation(activeEnv, message.body).catch(() => false)) {
      console.warn(JSON.stringify({
        event: 'minute_derive_revision_continuation_refreshed',
        derive_queue: queueName,
        revision_id: integer(message.body?.revision?.revision_id),
      }));
      message.ack();
      return;
    }
    const detail = {
      event: importInProgress(error) ? 'minute_derive_import_deferred' : 'minute_derive_message_failed',
      derive_queue: queueName,
      error: String(error?.message || error).slice(0, 800),
    };
    if (importInProgress(error)) console.warn(JSON.stringify(detail));
    else console.error(JSON.stringify(detail));
    if (error?.code === 'MINUTE_DERIVE_INVALID_TRIGGER') message.ack();
    else message.retry(RETRY_60_SECONDS);
  }
}

export async function processMinuteDeriveBatch(batch, env, dependencies = {}) {
  const messages = batch?.messages;
  if (!messages?.length) return;
  const activeEnv = activeDeriveEnv(batch, env);
  const queueName = batch?.queue || null;
  for (const message of messages) {
    await processOneMinuteDeriveMessage(message, activeEnv, queueName, dependencies);
  }
}

export default {
  queue: processMinuteDeriveBatch,
};
