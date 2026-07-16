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

function activeIngestEnv(env, message, channel) {
  const active = Object.create(env || null);
  const minuteQueue = env?.MINUTE_FACT_QUEUE;
  Object.defineProperties(active, {
    __shAuthState: { value: message.auth || {}, enumerable: false },
    __RAW_CHANNEL_PAYLOAD: { value: channel, enumerable: false },
    CHAT_LIMIT: { value: 0, enumerable: true },
    MINUTE_FACT_QUEUE: {
      enumerable: false,
      value: minuteQueue?.send ? {
        send(body, options) {
          if (body && typeof body === 'object') {
            const compact = { ...body, read_model: null };
            return minuteQueue.send(compact, options);
          }
          return minuteQueue.send(body, options);
        },
      } : minuteQueue,
    },
  });
  return active;
}

function readModelEnvelope(env, message, channel) {
  const state = collectorStateFromAuthState(message.auth, env);
  validateChannelPayload(channel, message.channel_alias || env.CHANNEL_ALIAS || 'buddies');
  extractIds(channel, state);
  const snapshot = normalizeSnapshot(channel, state, {
    channelAlias: message.channel_alias || env.CHANNEL_ALIAS || 'buddies',
    collectorId: env.COLLECTOR_ID || 'cloudflare-worker',
  });
  const queue = minuteFactQueue(extractQueue(channel, state.stationId));
  return {
    message_type: 'stationhead-read-model',
    message_version: 1,
    observed_at: Number(message.observed_at),
    job_id: `read-model:${state.channelId}:${Number(message.observed_at)}`,
    read_model: {
      channel: {
        channel_id: state.channelId,
        observed_at: Number(message.observed_at),
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
        collector_id: env.COLLECTOR_ID || 'cloudflare-worker',
        last_run_at: Number(message.observed_at),
        last_success_at: Number(message.observed_at),
        last_error_present: false,
        updated_at: Number(message.observed_at),
      },
    },
    comment_task: {
      observed_at: Number(message.observed_at),
      station_id: state.stationId,
      auth: message.auth || {},
    },
  };
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
  const envelope = readModelEnvelope(env, message, channel);
  const active = activeIngestEnv(env, message, channel);
  const result = await collectOnce(active, 'raw-collection-queue');
  await Promise.all([
    env.READ_MODEL_QUEUE.send(envelope, { contentType: 'json' }),
    env.COMMENTS_QUEUE.send({
      message_type: 'stationhead-comments-task',
      message_version: 1,
      ...envelope.comment_task,
    }, { contentType: 'json' }),
  ]);
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
