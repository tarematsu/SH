import 'dotenv/config';
import WebSocket from 'ws';
import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';

const API_BASE = 'https://production1.stationhead.com';
const PUSHER_KEY = '982c86a21530b654bfb2';
const PUSHER_URL = `wss://realtime-production.stationhead.com/app/${PUSHER_KEY}?protocol=7&client=js&version=7.4.0&flash=false`;

const cookieJar = new CookieJar();
const sessionFetch = fetchCookie(fetch, cookieJar);

const config = {
  ingestUrl: requireEnv('INGEST_URL'),
  ingestSecret: requireEnv('INGEST_SECRET'),
  channelAlias: process.env.CHANNEL_ALIAS || 'buddies',
  pollIntervalMs: numberEnv('POLL_INTERVAL_MS', 60_000),
  chatLimit: numberEnv('CHAT_LIMIT', 50),
  enableWebSocket: String(process.env.ENABLE_WEBSOCKET ?? 'true').toLowerCase() === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',
  stationheadCookie: process.env.STATIONHEAD_COOKIE || '',
  stationheadAuthToken: process.env.STATIONHEAD_AUTH_TOKEN || '',
  stationheadDeviceUid: process.env.STATIONHEAD_DEVICE_UID || '',
  stationheadAppVersion: process.env.STATIONHEAD_APP_VERSION || '1.0.0',
};

let runtime = {
  channelId: null,
  stationId: null,
  streamingPartyId: null,
  ws: null,
  reconnectTimer: null,
  stopped: false,
};

const levelRank = { debug: 10, info: 20, warn: 30, error: 40 };
function log(level, ...args) {
  if ((levelRank[level] ?? 20) >= (levelRank[config.logLevel] ?? 20)) {
    console.log(new Date().toISOString(), level.toUpperCase(), ...args);
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function numberEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

const BROWSER_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  origin: 'https://www.stationhead.com',
  referer: 'https://www.stationhead.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
};

async function warmUpSession() {
  if (config.stationheadCookie) {
    await cookieJar.setCookie(config.stationheadCookie, API_BASE);
  }

  // Stationhead creates an anonymous guest session in the browser before API access.
  await sessionFetch(`https://www.stationhead.com/c/${encodeURIComponent(config.channelAlias)}`, {
    headers: {
      ...BROWSER_HEADERS,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      origin: undefined,
      referer: undefined,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  }).catch((error) => log('warn', 'web warmup failed', error.message));

  for (const path of ['/timestamp', '/me/country']) {
    await sessionFetch(`${API_BASE}${path}`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(20_000),
    }).catch((error) => log('warn', `API warmup failed ${path}`, error.message));
  }
}

function stationheadApiHeaders(extra = {}) {
  const headers = {
    ...BROWSER_HEADERS,
    'app-platform': 'web',
    'app-version': config.stationheadAppVersion,
    'content-type': 'application/json',
    ...(config.stationheadDeviceUid ? { 'sth-device-uid': config.stationheadDeviceUid } : {}),
    ...(config.stationheadAuthToken ? { authorization: `Bearer ${config.stationheadAuthToken}` } : {}),
    ...(config.stationheadCookie ? { cookie: config.stationheadCookie } : {}),
    ...extra,
  };
  return headers;
}

async function fetchJson(url, options = {}) {
  const response = await sessionFetch(url, {
    ...options,
    headers: stationheadApiHeaders(options.headers || {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}: ${url}${body ? ` | ${body.slice(0, 300)}` : ''}`);
  }
  return response.json();
}

async function ingest(type, data, observedAt = Date.now()) {
  const response = await fetch(config.ingestUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.ingestSecret}`,
    },
    body: JSON.stringify({ type, observed_at: observedAt, data }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ingest failed ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json().catch(() => ({}));
}

function firstDefined(...values) {
  return values.find((v) => v !== undefined && v !== null);
}

function extractIds(channel) {
  const station = channel?.current_station || null;
  const party = station?.streaming_party || channel?.streaming_party || null;
  runtime.channelId = firstDefined(channel?.id, runtime.channelId);
  runtime.stationId = firstDefined(channel?.current_station_id, station?.id, runtime.stationId);
  runtime.streamingPartyId = firstDefined(party?.id, channel?.streaming_party_id, runtime.streamingPartyId);
}

function normalizeSnapshot(channel) {
  const station = channel?.current_station || {};
  const party = station?.streaming_party || channel?.streaming_party || {};
  const host = station?.broadcast?.broadcasters?.find((b) => b?.is_host) || station?.broadcast?.broadcasters?.[0] || null;
  return {
    channel_id: firstDefined(channel?.id, runtime.channelId),
    channel_alias: channel?.alias || config.channelAlias,
    channel_name: channel?.channel_name ?? null,
    station_id: firstDefined(channel?.current_station_id, station?.id, runtime.stationId),
    is_launched: station?.is_launched ?? null,
    is_broadcasting: station?.is_broadcasting ?? null,
    chat_status: station?.chat_status ?? null,
    listener_count: firstDefined(station?.listener_count, channel?.listener_count),
    online_member_count: channel?.online_member_count ?? null,
    total_member_count: channel?.total_member_count ?? null,
    guest_count: firstDefined(station?.guest_count, channel?.guest_count),
    total_listens: station?.total_listens ?? null,
    stream_goal: party?.stream_goal ?? null,
    current_stream_count: firstDefined(party?.current_stream_count, party?.current_stream_),
    host_account_id: firstDefined(host?.account_id, host?.account?.id),
    host_handle: host?.account?.handle ?? null,
    broadcast_start_time: station?.broadcast?.start_time ?? null,
    raw: channel,
  };
}

function normalizeComments(payload) {
  const candidates = [
    payload,
    payload?.items,
    payload?.data?.items,
    payload?.chats?.items,
    payload?.chats,
  ];
  const items = candidates.find(Array.isArray) || [];
  return items.map((chat) => ({
    id: chat?.id,
    station_id: chat?.station_id ?? runtime.stationId,
    account_id: chat?.account_id ?? chat?.account?.id ?? null,
    handle: chat?.account?.handle ?? null,
    text: chat?.text ?? null,
    text_with_xml: chat?.text_with_xml ?? null,
    chat_time: chat?.chat_time ?? null,
    chat_time_ms: chat?.chat_time_ms ?? null,
    all_access_chat: chat?.all_access_chat ?? null,
    boost_chat: chat?.boost_chat ?? null,
    active_stream_days: chat?.active_stream_days ?? null,
    followers: chat?.account?.followers ?? null,
    following: chat?.account?.following ?? null,
    emoji: chat?.account?.emoji ?? null,
    raw: chat,
  })).filter((x) => x.id != null);
}

function extractQueue(channel) {
  const station = channel?.current_station || {};
  const queue = station?.queue || channel?.queue || null;
  if (!queue) return null;
  const queueTracks = queue?.queue_tracks || queue?.tracks || [];
  return {
    station_id: firstDefined(queue?.station_id, station?.id, runtime.stationId),
    queue_id: queue?.id ?? null,
    start_time: queue?.start_time ?? null,
    is_paused: queue?.is_paused ?? null,
    tracks: queueTracks.map((item, index) => {
      const track = item?.track || item;
      return {
        position: index,
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


function cleanSpotifyTitle(rawTitle) {
  const cleaned = String(rawTitle || '')
    .replace(/\s*\|\s*Spotify\s*$/i, '')
    .replace(/\s*-\s*song and lyrics by\s*/i, ' — ')
    .trim();
  const [title, ...artistParts] = cleaned.split(/\s+—\s+/);
  return {
    title: title || rawTitle || null,
    artist: artistParts.join(' — ') || null,
    display_title: cleaned || rawTitle || null,
  };
}

async function lookupStoredTrackMetadata(ids) {
  if (!ids.length) return new Set();
  const url = new URL(config.ingestUrl);
  url.searchParams.set('type', 'track_lookup');
  url.searchParams.set('ids', ids.join(','));
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${config.ingestSecret}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`track lookup failed ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  return new Set((data.tracks || []).map((t) => t.spotify_id));
}

async function fetchSpotifyMetadata(spotifyId) {
  const spotifyUrl = `https://open.spotify.com/track/${encodeURIComponent(spotifyId)}`;
  const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    log('warn', `Spotify metadata failed id=${spotifyId} status=${response.status}`);
    return null;
  }
  const raw = await response.json();
  const parsed = cleanSpotifyTitle(raw.title);
  return {
    spotify_id: spotifyId,
    spotify_url: spotifyUrl,
    title: parsed.title,
    artist: parsed.artist,
    display_title: parsed.display_title,
    thumbnail_url: raw.thumbnail_url || null,
    source: 'spotify_oembed',
    fetched_at: Date.now(),
    raw,
  };
}

async function enrichNewTracks(queue, observedAt) {
  const ids = [...new Set((queue?.tracks || []).map((t) => t.spotify_id).filter(Boolean))];
  if (!ids.length) return;

  const stored = await lookupStoredTrackMetadata(ids);
  const missing = ids.filter((id) => !stored.has(id));
  if (!missing.length) {
    log('debug', `track metadata cache hit ${ids.length}/${ids.length}`);
    return;
  }

  const tracks = [];
  for (let i = 0; i < missing.length; i += 3) {
    const chunk = missing.slice(i, i + 3);
    const results = await Promise.all(chunk.map((id) => fetchSpotifyMetadata(id).catch((error) => {
      log('warn', `Spotify metadata error id=${id}`, error.message);
      return null;
    })));
    tracks.push(...results.filter(Boolean));
  }

  if (tracks.length) {
    await ingest('track_metadata', { tracks }, observedAt);
    log('info', `track metadata saved new=${tracks.length} cached=${stored.size}`);
  }
}

async function pollOnce() {
  const observedAt = Date.now();
  const channelUrl = `${API_BASE}/channels/alias/${encodeURIComponent(config.channelAlias)}`;
  const channel = await fetchJson(channelUrl);
  extractIds(channel);

  await ingest('snapshot', normalizeSnapshot(channel), observedAt);

  const queue = extractQueue(channel);
  if (queue) {
    await ingest('queue', queue, observedAt);
    await enrichNewTracks(queue, observedAt);
  }

  if (runtime.stationId) {
    const historyUrl = `${API_BASE}/station/${runtime.stationId}/chatHistory?limit=${config.chatLimit}`;
    const history = await fetchJson(historyUrl);
    const comments = normalizeComments(history);
    if (comments.length) await ingest('comments', { comments, raw_meta: { next: history?.chats?.next ?? history?.next ?? null } }, observedAt);
  }

  log('info', `poll ok channel=${runtime.channelId} station=${runtime.stationId} party=${runtime.streamingPartyId}`);
}

function parsePusherData(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function subscribe(ws, channel) {
  ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel } }));
}

function desiredChannels() {
  const channels = [];
  if (runtime.channelId) {
    channels.push(
      `production1_channel_${runtime.channelId}`,
      `production1_channel_${runtime.channelId}_broadcast`,
      `production1_channel_${runtime.channelId}_chats`,
      `production1_channel_${runtime.channelId}_listener_count`,
      `production1_channel_${runtime.channelId}_queue`,
    );
  }
  if (runtime.streamingPartyId) channels.push(`production1_streaming_party_${runtime.streamingPartyId}`);
  return channels;
}

async function handleWsMessage(raw) {
  const envelope = JSON.parse(raw.toString());
  const data = parsePusherData(envelope.data);

  if (envelope.event === 'pusher:connection_established') {
    for (const channel of desiredChannels()) subscribe(runtime.ws, channel);
    log('info', `websocket connected; subscribed=${desiredChannels().join(',')}`);
    return;
  }
  if (envelope.event === 'pusher:ping') {
    runtime.ws?.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
    return;
  }
  if (envelope.event?.startsWith('pusher_internal:')) return;

  await ingest('ws_event', {
    channel: envelope.channel ?? null,
    event: envelope.event ?? null,
    data,
    raw: envelope,
  }, Date.now());

  log('debug', 'ws event', envelope.channel, envelope.event);
}

function scheduleReconnect() {
  if (runtime.stopped || runtime.reconnectTimer) return;
  const delay = 5_000 + Math.floor(Math.random() * 5_000);
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = null;
    connectWebSocket();
  }, delay);
  log('warn', `websocket reconnect scheduled in ${delay}ms`);
}

function connectWebSocket() {
  if (!config.enableWebSocket || runtime.stopped) return;
  if (!runtime.channelId) {
    scheduleReconnect();
    return;
  }

  const ws = new WebSocket(PUSHER_URL, {
    headers: { origin: 'https://www.stationhead.com' },
  });
  runtime.ws = ws;

  ws.on('message', (raw) => {
    handleWsMessage(raw).catch((error) => log('error', 'ws message failed', error));
  });
  ws.on('error', (error) => log('warn', 'websocket error', error.message));
  ws.on('close', (code, reason) => {
    log('warn', `websocket closed code=${code} reason=${reason}`);
    if (runtime.ws === ws) runtime.ws = null;
    scheduleReconnect();
  });
}

function validateStationheadAuth() {
  if (!config.stationheadAuthToken) {
    throw new Error('STATIONHEAD_AUTH_TOKEN is required');
  }
  if (!config.stationheadDeviceUid) {
    throw new Error('STATIONHEAD_DEVICE_UID is required');
  }
  log('info', `Stationhead auth loaded token=${config.stationheadAuthToken.length}chars device=${config.stationheadDeviceUid.slice(0, 8)}... appVersion=${config.stationheadAppVersion}`);
}

async function main() {
  const once = process.argv.includes('--once');
  await warmUpSession();
  await pollOnce();
  if (once) return;

  connectWebSocket();
  const timer = setInterval(() => {
    pollOnce().catch((error) => log('error', 'poll failed', error));
  }, config.pollIntervalMs);

  const shutdown = () => {
    runtime.stopped = true;
    clearInterval(timer);
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.ws?.close(1000, 'shutdown');
    setTimeout(() => process.exit(0), 250).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  log('error', error);
  process.exitCode = 1;
});
