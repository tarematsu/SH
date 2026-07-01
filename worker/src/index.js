import { onRequestPost as saveIngest } from '../../site/functions/api/ingest.js';
import {
  jsonResponse as json, normalizeBearer, jwtExpiryMs, positiveNumber as numberValue,
  normalizeComments as sharedNormalizeComments, enrichTracks as sharedEnrichTracks,
} from './shared.js';

const API_BASE = 'https://production1.stationhead.com';
const COLLECTOR_VERSION = '1.0.0-worker';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
let collectionFlight = null;

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function configFromEnv(env) {
  return {
    channelAlias: env.CHANNEL_ALIAS || 'buddies',
    chatLimit: Math.min(numberValue(env.CHAT_LIMIT, 100), 100),
    appVersion: env.STATIONHEAD_APP_VERSION || '1.0.0',
    collectorId: env.COLLECTOR_ID || 'cloudflare-worker',
    metadataLimit: Math.min(numberValue(env.METADATA_LIMIT, 3), 10),
    requestTimeoutMs: Math.min(numberValue(env.REQUEST_TIMEOUT_MS, 15_000), 30_000),
  };
}

export function collectorStateFromAuthState(authState, env = {}) {
  const authToken = normalizeBearer(authState?.authToken || env.STATIONHEAD_AUTH_TOKEN);
  const deviceUid = String(authState?.deviceUid || env.STATIONHEAD_DEVICE_UID || '').trim();
  if (!authToken || !deviceUid) {
    throw new Error('Stationhead session is missing. Set STATIONHEAD_AUTH_TOKEN and STATIONHEAD_DEVICE_UID from collector/.stationhead-session.json.');
  }
  return {
    authToken,
    deviceUid,
    tokenExpiresAt: jwtExpiryMs(authToken) || Number(authState?.tokenExpiresAt || 0),
    lastRunAt: Number(authState?.collectorLastRunAt || 0),
    lastSuccessAt: Number(authState?.collectorLastSuccessAt || 0),
    lastError: authState?.collectorLastError || null,
    channelId: Number(authState?.collectorChannelId || 0) || null,
    stationId: Number(authState?.collectorStationId || 0) || null,
  };
}

async function loadState(env) {
  if (env.__stationheadAuthState) {
    return collectorStateFromAuthState(env.__stationheadAuthState, env);
  }

  const row = await env.DB.prepare(`
    SELECT auth_token, device_uid, token_expires_at, last_run_at, last_success_at,
           last_error, last_channel_id, last_station_id, updated_at
    FROM sh_worker_collector_state
    WHERE id = 'stationhead'
  `).first();

  const authToken = normalizeBearer(row?.auth_token || env.STATIONHEAD_AUTH_TOKEN);
  const deviceUid = String(row?.device_uid || env.STATIONHEAD_DEVICE_UID || '').trim();

  if (!authToken || !deviceUid) {
    throw new Error('Stationhead session is missing. Set STATIONHEAD_AUTH_TOKEN and STATIONHEAD_DEVICE_UID from collector/.stationhead-session.json.');
  }

  return {
    authToken,
    deviceUid,
    tokenExpiresAt: jwtExpiryMs(authToken) || Number(row?.token_expires_at || 0),
    lastRunAt: Number(row?.last_run_at || 0),
    lastSuccessAt: Number(row?.last_success_at || 0),
    lastError: row?.last_error || null,
    channelId: Number(row?.last_channel_id || 0) || null,
    stationId: Number(row?.last_station_id || 0) || null,
  };
}

async function saveState(env, state, patch = {}) {
  Object.assign(state, patch);
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO sh_worker_collector_state (
      id, auth_token, device_uid, token_expires_at, last_run_at, last_success_at,
      last_error, last_channel_id, last_station_id, updated_at
    ) VALUES ('stationhead', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      auth_token=excluded.auth_token,
      device_uid=excluded.device_uid,
      token_expires_at=excluded.token_expires_at,
      last_run_at=excluded.last_run_at,
      last_success_at=excluded.last_success_at,
      last_error=excluded.last_error,
      last_channel_id=excluded.last_channel_id,
      last_station_id=excluded.last_station_id,
      updated_at=excluded.updated_at
  `).bind(
    state.authToken,
    state.deviceUid,
    state.tokenExpiresAt || jwtExpiryMs(state.authToken) || null,
    state.lastRunAt || null,
    state.lastSuccessAt || null,
    state.lastError || null,
    state.channelId || null,
    state.stationId || null,
    now,
  ).run();
}

function stationheadHeaders(state, config) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    authorization: `Bearer ${state.authToken}`,
    'app-platform': 'web',
    'app-version': config.appVersion,
    'content-type': 'application/json',
    origin: 'https://www.stationhead.com',
    referer: 'https://www.stationhead.com/',
    'sth-device-uid': state.deviceUid,
    'user-agent': DEFAULT_USER_AGENT,
  };
}

async function stationheadJson(state, config, path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: stationheadHeaders(state, config),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const refreshed = normalizeBearer(response.headers.get('authorization'));
  if (refreshed && refreshed !== state.authToken) {
    state.authToken = refreshed;
    state.tokenExpiresAt = jwtExpiryMs(refreshed);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 401) {
      throw new Error(`Stationhead session expired (401). Refresh collector/.stationhead-session.json and update Worker secrets. ${body.slice(0, 200)}`);
    }
    throw new Error(`Stationhead API ${response.status}: ${path}${body ? ` | ${body.slice(0, 300)}` : ''}`);
  }

  return response.json();
}

async function ingest(env, type, data, observedAt) {
  const internalSecret = env.INGEST_SECRET || 'worker-internal-ingest';
  const request = new Request('https://worker.internal/api/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${internalSecret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type,
      observed_at: observedAt,
      collector_id: env.COLLECTOR_ID || 'cloudflare-worker',
      data,
    }),
  });
  const response = await saveIngest({
    request,
    env: { DB: env.DB, INGEST_SECRET: internalSecret },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`D1 ingest failed ${response.status}: ${body.slice(0, 500)}`);
  }
  return type === 'queue' ? response.json().catch(() => ({})) : null;
}

function extractIds(channel, state) {
  const station = channel?.current_station || null;
  const party = station?.streaming_party || channel?.streaming_party || null;
  state.channelId = firstDefined(channel?.id, state.channelId);
  state.stationId = firstDefined(channel?.current_station_id, station?.id, state.stationId);
  return { station, party };
}

function normalizeSnapshot(channel, state, config) {
  const station = channel?.current_station || {};
  const party = station?.streaming_party || channel?.streaming_party || {};
  const host = station?.broadcast?.broadcasters?.find((item) => item?.is_host)
    || station?.broadcast?.broadcasters?.[0]
    || null;
  return {
    channel_id: firstDefined(channel?.id, state.channelId),
    channel_alias: channel?.alias || config.channelAlias,
    channel_name: channel?.channel_name ?? null,
    station_id: firstDefined(channel?.current_station_id, station?.id, state.stationId),
    is_launched: station?.is_launched ?? null,
    is_broadcasting: station?.is_broadcasting ?? null,
    chat_status: station?.chat_status ?? null,
    listener_count: firstDefined(station?.listener_count, channel?.listener_count),
    online_member_count: channel?.online_member_count ?? null,
    total_member_count: channel?.total_member_count ?? null,
    guest_count: firstDefined(station?.guest_count, channel?.guest_count),
    total_listens: station?.total_listens ?? null,
    stream_goal: party?.stream_goal ?? null,
    current_stream_count: party?.current_stream_count ?? null,
    host_account_id: firstDefined(host?.account_id, host?.account?.id),
    host_handle: host?.account?.handle ?? null,
    broadcast_start_time: station?.broadcast?.start_time ?? null,
    raw: channel,
  };
}

function normalizeComments(payload, stationId) {
  return sharedNormalizeComments(payload, stationId);
}

function extractQueue(channel, stationId) {
  const station = channel?.current_station || {};
  const queue = station?.queue || channel?.queue || null;
  if (!queue) return null;
  const queueTracks = queue?.queue_tracks || queue?.tracks || [];
  return {
    station_id: firstDefined(queue?.station_id, station?.id, stationId),
    queue_id: queue?.id ?? null,
    start_time: queue?.start_time ?? null,
    is_paused: queue?.is_paused ?? null,
    tracks: queueTracks.map((item, position) => {
      const track = item?.track || item;
      return {
        position,
        queue_track_id: item?.id ?? null,
        stationhead_track_id: track?.id ?? null,
        spotify_id: track?.spotify_id ?? null,
        apple_music_id: track?.apple_music_id ?? null,
        deezer_id: track?.deezer_id ?? null,
        isrc: track?.isrc ?? null,
        duration_ms: track?.duration ?? null,
        preview_url: track?.preview ?? null,
        bite_count: track?.bite_count ?? null,
        raw: item,
      };
    }),
    raw: queue,
  };
}

async function enrichTracks(env, queue, observedAt, config) {
  return sharedEnrichTracks(env, ingest, queue, observedAt, config);
}

export async function collectOnce(env, source = 'manual') {
  if (!env.DB) throw new Error('DB binding is missing');
  const config = configFromEnv(env);
  const state = await loadState(env);
  const observedAt = Date.now();
  state.lastRunAt = observedAt;
  state.lastError = null;

  try {
    const channel = await stationheadJson(state, config, `/channels/alias/${encodeURIComponent(config.channelAlias)}`);
    extractIds(channel, state);

    await ingest(env, 'collector_heartbeat', {
      collector_id: config.collectorId,
      hostname: 'cloudflare-workers',
      version: COLLECTOR_VERSION,
      channel_alias: config.channelAlias,
      websocket_enabled: false,
      invocation_source: source,
    }, observedAt);
    await ingest(env, 'snapshot', normalizeSnapshot(channel, state, config), observedAt);

    const queue = extractQueue(channel, state.stationId);
    let queueResult = null;
    let metadataSaved = 0;
    if (queue) {
      queueResult = await ingest(env, 'queue', queue, observedAt);
      metadataSaved = await enrichTracks(env, queue, observedAt, config);
    }

    let commentsSaved = 0;
    if (state.stationId) {
      const history = await stationheadJson(
        state,
        config,
        `/station/${encodeURIComponent(state.stationId)}/chatHistory?limit=${config.chatLimit}`,
      );
      const comments = normalizeComments(history, state.stationId);
      commentsSaved = comments.length;
      await ingest(env, 'comments', {
        station_id: state.stationId,
        comments,
        raw_meta: { next: history?.chats?.next ?? history?.next ?? null },
      }, observedAt);
    }

    await saveState(env, state, {
      lastRunAt: observedAt,
      lastSuccessAt: Date.now(),
      lastError: null,
      tokenExpiresAt: jwtExpiryMs(state.authToken) || state.tokenExpiresAt,
    });

    return {
      ok: true,
      source,
      observed_at: observedAt,
      channel_alias: config.channelAlias,
      channel_id: state.channelId,
      station_id: state.stationId,
      comments_saved: commentsSaved,
      queue_tracks: queue?.tracks?.length || 0,
      queue_inspected: Boolean(queueResult?.queue_inspected),
      queue_items_written: Number(queueResult?.queue_items_written || 0),
      like_observations_written: Number(queueResult?.like_observations_written || 0),
      metadata_saved: metadataSaved,
      token_expires_at: state.tokenExpiresAt || null,
    };
  } catch (error) {
    await saveState(env, state, {
      lastRunAt: observedAt,
      lastError: String(error?.message || error).slice(0, 2000),
      tokenExpiresAt: jwtExpiryMs(state.authToken) || state.tokenExpiresAt,
    }).catch(() => {});
    throw error;
  }
}

export function runCollection(env, source = 'manual', collector = collectOnce) {
  if (collectionFlight) return collectionFlight;
  collectionFlight = Promise.resolve()
    .then(() => collector(env, source))
    .finally(() => { collectionFlight = null; });
  return collectionFlight;
}

export function resetCollectionFlight() {
  collectionFlight = null;
}

function authorized(request, env) {
  const expected = String(env.RUN_SECRET || '').trim();
  return Boolean(expected) && request.headers.get('authorization') === `Bearer ${expected}`;
}

async function health(env) {
  if (!env.DB) return { ok: false, error: 'DB binding is missing' };
  const cached = env.__stationheadAuthState;
  const row = cached ? {
    token_expires_at: cached.tokenExpiresAt || null,
    last_run_at: cached.collectorLastRunAt || null,
    last_success_at: cached.collectorLastSuccessAt || null,
    last_error: cached.collectorLastError || null,
    last_channel_id: cached.collectorChannelId || null,
    last_station_id: cached.collectorStationId || null,
    updated_at: cached.collectorUpdatedAt || null,
  } : await env.DB.prepare(`
    SELECT token_expires_at, last_run_at, last_success_at, last_error,
           last_channel_id, last_station_id, updated_at
    FROM sh_worker_collector_state
    WHERE id = 'stationhead'
  `).first();
  return {
    ok: true,
    configured: Boolean(cached?.authToken && cached?.deviceUid)
      || Boolean(row || (env.STATIONHEAD_AUTH_TOKEN && env.STATIONHEAD_DEVICE_UID)),
    token_expires_at: row?.token_expires_at || null,
    last_run_at: row?.last_run_at || null,
    last_success_at: row?.last_success_at || null,
    last_error: row?.last_error || null,
    channel_id: row?.last_channel_id || null,
    station_id: row?.last_station_id || null,
    updated_at: row?.updated_at || null,
  };
}

export default {
  async scheduled(controller, env) {
    const result = await runCollection(env, `cron:${controller.cron}`);
    console.log(JSON.stringify(result));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json(await health(env));
    }
    if (request.method === 'POST' && url.pathname === '/run') {
      if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
      try {
        return json(await runCollection(env, 'http'));
      } catch (error) {
        console.error(error);
        return json({ ok: false, error: error?.message || String(error) }, 500);
      }
    }
    return json({ ok: false, error: 'not found' }, 404);
  },
};
