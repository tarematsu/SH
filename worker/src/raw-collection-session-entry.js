import { ensureSession } from './raw-collector-entry.js';
import { RAW_COLLECTION_FETCH_MESSAGE } from './raw-collection-messages.js';

const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function prepareRawCollectionFetch(env, body = {}, dependencies = {}) {
  const queue = env?.HOST_MONITOR_QUEUE;
  if (!queue?.send && !dependencies.send) {
    throw new Error('HOST_MONITOR_QUEUE binding is missing for raw collection fetch');
  }
  const state = await (dependencies.ensureSession || ensureSession)(env);
  const message = {
    message_type: RAW_COLLECTION_FETCH_MESSAGE,
    message_version: 1,
    scheduled_at: Number(body.scheduled_at) || Date.now(),
    channel_alias: env?.CHANNEL_ALIAS || 'buddies',
    app_version: env?.STATIONHEAD_APP_VERSION || env?.SH_APP_VERSION || '1.0.0',
    request_timeout_ms: Math.min(positive(env?.REQUEST_TIMEOUT_MS, 15_000), 30_000),
    auth: {
      authToken: state.authToken,
      deviceUid: state.deviceUid,
      tokenExpiresAt: state.tokenExpiresAt,
      collectorLastRunAt: state.collectorLastRunAt,
      collectorLastSuccessAt: state.collectorLastSuccessAt,
      collectorLastError: state.collectorLastError,
      collectorChannelId: state.collectorChannelId,
      collectorStationId: state.collectorStationId,
      collectorUpdatedAt: state.collectorUpdatedAt,
    },
  };
  if (dependencies.send) await dependencies.send(message);
  else await queue.send(message, JSON_QUEUE_SEND_OPTIONS);
  return { prepared: true, scheduled_at: message.scheduled_at };
}
