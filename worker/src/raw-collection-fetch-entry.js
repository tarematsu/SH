import { API_BASE, shHeaders } from './collector-config.js';
import { jwtExpiryMs, normalizeBearer } from './shared.js';

const RAW_COLLECTION_QUEUE_OPTIONS = Object.freeze({ contentType: 'json' });

export async function fetchPreparedRawCollection(env, body = {}, dependencies = {}) {
  if (Number(body.message_version) !== 1) {
    throw new Error('unsupported raw collection fetch task version');
  }
  const auth = body.auth || {};
  if (!auth.authToken || !auth.deviceUid) throw new Error('raw collection auth is missing');
  const queue = env?.RAW_COLLECTION_QUEUE;
  if (!queue?.send && !dependencies.send) throw new Error('RAW_COLLECTION_QUEUE binding is missing');
  const observedAt = Date.now();
  const config = {
    channelAlias: body.channel_alias || 'buddies',
    appVersion: body.app_version || '1.0.0',
    requestTimeoutMs: Math.max(1_000, Math.min(Number(body.request_timeout_ms) || 15_000, 30_000)),
  };
  const response = await (dependencies.fetch || fetch)(
    `${API_BASE}/channels/alias/${encodeURIComponent(config.channelAlias)}`,
    {
      headers: shHeaders(auth, config),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    },
  );
  if (!response.ok) throw new Error(`Stationhead API ${response.status}: channel`);
  const rawBody = await response.text();
  const refreshed = normalizeBearer(response.headers.get('authorization'));
  const activeToken = refreshed || auth.authToken;
  const activeExpiry = refreshed ? jwtExpiryMs(refreshed) : auth.tokenExpiresAt;
  const message = {
    message_type: 'stationhead-raw-channel',
    message_version: 1,
    observed_at: observedAt,
    channel_alias: config.channelAlias,
    body: rawBody,
    persist_credentials: !auth.collectorUpdatedAt || Boolean(refreshed && refreshed !== auth.authToken),
    auth: {
      authToken: activeToken,
      deviceUid: auth.deviceUid,
      tokenExpiresAt: activeExpiry,
      collectorLastRunAt: auth.collectorLastRunAt,
      collectorLastSuccessAt: auth.collectorLastSuccessAt,
      collectorLastError: auth.collectorLastError,
      collectorChannelId: auth.collectorChannelId,
      collectorStationId: auth.collectorStationId,
    },
  };
  if (dependencies.send) await dependencies.send(message);
  else await queue.send(message, RAW_COLLECTION_QUEUE_OPTIONS);
  console.log(JSON.stringify({
    event: 'raw_collection_enqueued',
    observed_at: observedAt,
    payload_chars: rawBody.length,
    queue_total_tracks: 0,
    queue_materialized_tracks: 0,
  }));
  return { fetched: true, observed_at: observedAt, payload_chars: rawBody.length };
}
