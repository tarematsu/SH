import { withAppleMusicFreeRuntime } from '../../site/functions/lib/apple-music-d1-pruner.js';
import { withMinuteD1WriteThrottling } from './minute-d1-write-throttle.js';
import {
  processMinuteDeriveMessage,
} from './minute-derive-router.js';

export const LIVE_DERIVE_QUEUE_NAME = 'stationhead-minute-live-derive';
export const REBUILD_DERIVE_QUEUE_NAME = 'stationhead-minute-derive';

const RETRY_60_SECONDS = Object.freeze({ delaySeconds: 60 });
const SUCCESS_LOG_SAMPLE_MODULUS = 16;
const LIVE_REVISION_CHUNK_TRACKS = 1;
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json', delaySeconds: 1 });
const SOURCE_PAYLOAD_ERROR = /queue revision \d+ source payload is unavailable or incomplete/i;

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

export function activeDeriveEnv(batch, env) {
  const active = withMinuteD1WriteThrottling(withAppleMusicFreeRuntime(env));
  const sourceQueue = String(batch?.queue || '');
  const continuation = sourceQueue === LIVE_DERIVE_QUEUE_NAME
    ? env?.MINUTE_LIVE_DERIVE_QUEUE || env?.MINUTE_DERIVE_QUEUE
    : sourceQueue === REBUILD_DERIVE_QUEUE_NAME
      ? env?.MINUTE_DERIVE_QUEUE
      : env?.MINUTE_LIVE_DERIVE_QUEUE || env?.MINUTE_DERIVE_QUEUE;
  if (continuation) {
    Object.defineProperty(active, 'MINUTE_DERIVE_QUEUE', {
      value: continuation,
      enumerable: false,
      configurable: true,
    });
  }
  if (sourceQueue === LIVE_DERIVE_QUEUE_NAME) {
    Object.defineProperty(active, 'DERIVE_REVISION_CHUNK_TRACKS', {
      value: LIVE_REVISION_CHUNK_TRACKS,
      enumerable: false,
      configurable: true,
    });
  }
  return active;
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

export async function processMinuteDeriveBatch(batch, env) {
  const messages = batch.messages;
  if (!messages?.length) return;
  const message = messages[0];
  const activeEnv = activeDeriveEnv(batch, env);

  try {
    const result = await processMinuteDeriveMessage(activeEnv, message.body);
    logMinuteDeriveResult(result, batch?.queue || null);
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
        && await refreshSparseRevisionContinuation(activeEnv, message.body).catch(() => false)) {
      console.warn(JSON.stringify({
        event: 'minute_derive_revision_continuation_refreshed',
        derive_queue: batch?.queue || null,
        revision_id: integer(message.body?.revision?.revision_id),
      }));
      message.ack();
      return;
    }
    const detail = {
      event: importInProgress(error) ? 'minute_derive_import_deferred' : 'minute_derive_message_failed',
      derive_queue: batch?.queue || null,
      error: String(error?.message || error).slice(0, 800),
    };
    if (importInProgress(error)) console.warn(JSON.stringify(detail));
    else console.error(JSON.stringify(detail));
    if (error?.code === 'MINUTE_DERIVE_INVALID_TRIGGER') message.ack();
    else message.retry(RETRY_60_SECONDS);
  }
}

export default {
  queue: processMinuteDeriveBatch,
};
