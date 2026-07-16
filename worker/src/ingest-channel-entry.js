import { collectOnce } from './collector-runner.js';
import {
  extractIds,
  extractQueue,
  minuteFactQueue,
  normalizeSnapshot,
  readModelPresentation,
  validateChannelPayload,
} from './collector-payload.js';
import { collectorStateFromAuthState } from './collector-state.js';
import { parseMinuteFactQueueMessage } from './minute-facts-queue.js';

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function commentsTaskForMinuteFact(commentTask, body) {
  const compact = { ...body, read_model: null };
  return {
    message_type: 'stationhead-comments-task',
    message_version: 2,
    auth: commentTask?.auth || {},
    observed_at: integer(body?.payload?.observedAt) ?? integer(commentTask?.observed_at) ?? Date.now(),
    station_id: integer(body?.payload?.snapshot?.station_id) ?? integer(commentTask?.station_id),
    minute_fact: compact,
  };
}

export function readModelEnvelopeForMinuteFact(rawMessage, body) {
  const parsed = parseMinuteFactQueueMessage(body);
  const compact = objectValue(body?.read_model);
  if (!compact) throw new Error('minute fact read model is missing');

  const observedAt = integer(rawMessage?.observed_at) ?? integer(parsed.payload?.observedAt) ?? Date.now();
  const compactChannel = objectValue(compact.channel) || {};
  const compactQueue = objectValue(compact.queue);
  const compactCollector = objectValue(compact.collector) || {};
  const queue = compactQueue && !Object.hasOwn(compactQueue, 'value')
    ? { ...compactQueue, value: parsed.payload.queue ?? null }
    : compactQueue;
  const readModel = {
    ...compact,
    channel: { ...compactChannel, observed_at: observedAt },
    queue,
    collector: {
      ...compactCollector,
      last_run_at: observedAt,
      last_success_at: observedAt,
      updated_at: observedAt,
    },
  };

  return {
    message_type: 'stationhead-read-model',
    message_version: 1,
    observed_at: observedAt,
    job_id: `read-model:${parsed.channel_id}:${observedAt}`,
    read_model: readModel,
    comment_task: {
      observed_at: observedAt,
      station_id: integer(parsed.payload?.snapshot?.station_id),
      auth: rawMessage?.auth || {},
    },
  };
}

function fallbackReadModelEnvelope(env, message, channel) {
  const state = collectorStateFromAuthState(message.auth, env);
  const channelAlias = message.channel_alias || env.CHANNEL_ALIAS || 'buddies';
  const collectorId = env.COLLECTOR_ID || 'cloudflare-worker';
  const observedAt = Number(message.observed_at);
  validateChannelPayload(channel, channelAlias);
  extractIds(channel, state);
  const snapshot = normalizeSnapshot(channel, state, { channelAlias, collectorId });
  const queue = minuteFactQueue(extractQueue(channel, state.stationId));
  return {
    message_type: 'stationhead-read-model',
    message_version: 1,
    observed_at: observedAt,
    job_id: `read-model:${state.channelId}:${observedAt}`,
    read_model: {
      channel: {
        channel_id: state.channelId,
        observed_at: observedAt,
        presentation: readModelPresentation(snapshot),
      },
      queue: {
        station_id: queue?.station_id ?? state.stationId,
        queue_id: queue?.queue_id ?? null,
        start_time: queue?.start_time ?? null,
        is_paused: queue?.is_paused ?? null,
        value: queue,
      },
      collector: {
        collector_id: collectorId,
        last_run_at: observedAt,
        last_success_at: observedAt,
        last_error_present: false,
        updated_at: observedAt,
      },
    },
    comment_task: {
      observed_at: observedAt,
      station_id: state.stationId,
      auth: message.auth || {},
    },
  };
}

function activeIngestEnv(env, message, channel, envelopes) {
  const active = Object.create(env || null);
  const commentsQueue = env?.COMMENTS_QUEUE;
  const commentTask = {
    observed_at: integer(message?.observed_at),
    station_id: null,
    auth: message?.auth || {},
  };
  Object.defineProperties(active, {
    __shAuthState: { value: message.auth || {}, enumerable: false },
    __RAW_CHANNEL_PAYLOAD: { value: channel, enumerable: false },
    CHAT_LIMIT: { value: 0, enumerable: true },
    MINUTE_FACT_QUEUE: {
      enumerable: false,
      value: commentsQueue?.send ? {
        send(body, options) {
          if (body && typeof body === 'object') {
            const envelope = readModelEnvelopeForMinuteFact(message, body);
            envelopes.set(String(body.job_id || ''), envelope);
            return commentsQueue.send(commentsTaskForMinuteFact(commentTask, body), options);
          }
          return commentsQueue.send(body, options);
        },
      } : commentsQueue,
    },
  });
  return active;
}

async function currentReadModelEnvelope(env, message, channel, result, envelopes) {
  const channelId = integer(result?.channel_id);
  const minuteAt = integer(result?.minute_fact_job_minute_at);
  const jobId = channelId != null && minuteAt != null ? `minute-fact:${channelId}:${minuteAt}` : null;
  if (!jobId) throw new Error('current minute fact identity is missing');
  const captured = envelopes.get(jobId);
  if (captured) return captured;

  try {
    const row = await env.DB.prepare(`SELECT payload_json
      FROM sh_minute_fact_outbox
      WHERE job_id=? AND status='pending'
      LIMIT 1`).bind(jobId).first();
    if (row?.payload_json) {
      const body = JSON.parse(String(row.payload_json));
      return readModelEnvelopeForMinuteFact(message, body);
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'current_read_model_outbox_reuse_failed',
      job_id: jobId,
      error: String(error?.message || error).slice(0, 500),
    }));
  }

  // A retried raw message can find its minute outbox row already sent and
  // compacted to '{}', while the previous read-model Queue send never
  // completed. Preserve that retry path by rebuilding only in this rare case.
  return fallbackReadModelEnvelope(env, message, channel);
}

export async function ingestRawCollection(env, message) {
  if (message?.message_type !== 'stationhead-raw-channel' || Number(message?.message_version) !== 1) {
    throw new Error('unsupported raw collection message');
  }
  let channel;
  try {
    channel = JSON.parse(String(message.body || ''));
  } catch (error) {
    throw new Error(`invalid raw channel JSON: ${error?.message || error}`);
  }
  const envelopes = new Map();
  const active = activeIngestEnv(env, message, channel, envelopes);
  const result = await collectOnce(active, 'raw-collection-queue');
  const envelope = await currentReadModelEnvelope(env, message, channel, result, envelopes);
  await env.READ_MODEL_QUEUE.send(envelope, { contentType: 'json' });
  return result;
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages || []) {
      try {
        await ingestRawCollection(env, message.body);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'raw_collection_ingest_failed',
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
