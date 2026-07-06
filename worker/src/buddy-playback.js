import {
  fetchTrackMetadata,
  metadataNeedsRefresh,
  normalizeBearer,
} from './shared.js';

const API_BASE = 'https://production1.stationhead.com';
const DEFAULT_ALIAS = 'buddy46';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_TRACKS = 80;
const DEFAULT_METADATA_LIMIT = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const METADATA_FAILURE_RETRY_MS = 15 * 60_000;
const METADATA_FAILURE_CACHE_MAX = 256;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export const BUDDY_PLAYBACK_SELECT_SQL = `SELECT state_hash,queue_json,checked_at,changed_at
  FROM sh_playback_channel_current WHERE channel_alias=?`;

export const BUDDY_PLAYBACK_TOUCH_SQL = `UPDATE sh_playback_channel_current
  SET checked_at=? WHERE channel_alias=?`;

export const BUDDY_PLAYBACK_UPSERT_SQL = `INSERT INTO sh_playback_channel_current (
  channel_alias,station_id,queue_id,start_time,is_paused,is_broadcasting,
  host_account_id,host_handle,state_hash,queue_json,checked_at,changed_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(channel_alias) DO UPDATE SET
  station_id=excluded.station_id,
  queue_id=excluded.queue_id,
  start_time=excluded.start_time,
  is_paused=excluded.is_paused,
  is_broadcasting=excluded.is_broadcasting,
  host_account_id=excluded.host_account_id,
  host_handle=excluded.host_handle,
  state_hash=excluded.state_hash,
  queue_json=excluded.queue_json,
  checked_at=excluded.checked_at,
  changed_at=excluded.changed_at`;

let buddyPlaybackFlight = null;
const metadataFailureUntil = new Map();

function finiteNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return Boolean(value);
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

function enabled(value) {
  if (value == null || value === '') return true;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

function missingTable(error) {
  return /no such table:\s*sh_playback_channel_current/i.test(String(error?.message || error));
}

function trimMetadataFailures() {
  while (metadataFailureUntil.size > METADATA_FAILURE_CACHE_MAX) {
    metadataFailureUntil.delete(metadataFailureUntil.keys().next().value);
  }
}

function metadataRetryBlocked(spotifyId, now) {
  const retryAt = Number(metadataFailureUntil.get(spotifyId) || 0);
  if (retryAt > now) return true;
  if (retryAt) metadataFailureUntil.delete(spotifyId);
  return false;
}

function markMetadataFailure(spotifyId, now) {
  metadataFailureUntil.set(spotifyId, now + METADATA_FAILURE_RETRY_MS);
  trimMetadataFailures();
}

export function buddyPlaybackConfig(env = {}) {
  return {
    enabled: enabled(env.BUDDY_PLAYBACK_ENABLED),
    alias: String(env.BUDDY_PLAYBACK_ALIAS || DEFAULT_ALIAS).trim().toLowerCase() || DEFAULT_ALIAS,
    intervalMs: positiveInteger(env.BUDDY_PLAYBACK_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    maxTracks: positiveInteger(env.BUDDY_PLAYBACK_MAX_TRACKS, DEFAULT_MAX_TRACKS, 80),
    metadataLimit: positiveInteger(
      env.BUDDY_PLAYBACK_METADATA_LIMIT,
      DEFAULT_METADATA_LIMIT,
      5,
    ),
    requestTimeoutMs: positiveInteger(
      env.REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      30_000,
    ),
    appVersion: String(env.STATIONHEAD_APP_VERSION || '1.0.0'),
  };
}

export function shouldRunBuddyPlayback(now = Date.now(), intervalMs = DEFAULT_INTERVAL_MS) {
  const interval = Math.max(60_000, positiveInteger(intervalMs, DEFAULT_INTERVAL_MS));
  const minute = Math.floor(now / 60_000);
  const intervalMinutes = Math.max(1, Math.round(interval / 60_000));
  return minute % intervalMinutes === 0;
}

async function loadSession(env) {
  const cached = env.__stationheadAuthState;
  if (cached) {
    const authToken = normalizeBearer(cached.authToken || env.STATIONHEAD_AUTH_TOKEN);
    const deviceUid = String(cached.deviceUid || env.STATIONHEAD_DEVICE_UID || '').trim();
    if (authToken && deviceUid) return { authToken, deviceUid };
  }

  const row = await env.DB.prepare(`SELECT auth_token,device_uid
    FROM sh_worker_collector_state WHERE id='stationhead'`).first();
  const authToken = normalizeBearer(row?.auth_token || env.STATIONHEAD_AUTH_TOKEN);
  const deviceUid = String(row?.device_uid || env.STATIONHEAD_DEVICE_UID || '').trim();
  if (!authToken || !deviceUid) {
    throw new Error('Stationhead session is missing for buddy46 playback collection');
  }
  return { authToken, deviceUid };
}

function stationheadHeaders(session, config) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    authorization: `Bearer ${session.authToken}`,
    'app-platform': 'web',
    'app-version': config.appVersion,
    'content-type': 'application/json',
    origin: 'https://www.stationhead.com',
    referer: 'https://www.stationhead.com/',
    'sth-device-uid': session.deviceUid,
    'user-agent': USER_AGENT,
  };
}

export function validateBuddyChannelPayload(channel, expectedAlias = DEFAULT_ALIAS) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
    throw new Error('Stationhead buddy playback response is not an object');
  }
  const actualAlias = String(channel.alias || channel.channel_alias || '').trim().toLowerCase();
  if (!actualAlias) throw new Error('Stationhead buddy playback response is missing channel alias');
  if (actualAlias !== String(expectedAlias).trim().toLowerCase()) {
    throw new Error(`Stationhead alias mismatch: expected ${expectedAlias}, received ${actualAlias}`);
  }
  if (!('current_station' in channel) && !('current_station_id' in channel)) {
    throw new Error('Stationhead buddy playback response is missing current station fields');
  }
  return channel;
}

async function fetchChannel(env, session, config, request = fetch) {
  const response = await request(
    `${API_BASE}/channels/alias/${encodeURIComponent(config.alias)}`,
    {
      headers: stationheadHeaders(session, config),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Stationhead buddy playback API ${response.status}: ${body.slice(0, 200)}`);
  }
  return validateBuddyChannelPayload(await response.json(), config.alias);
}

export function extractBuddyPlayback(channel, alias = DEFAULT_ALIAS, maxTracks = DEFAULT_MAX_TRACKS) {
  const station = channel?.current_station || {};
  const queue = station?.queue || channel?.queue || null;
  const host = station?.broadcast?.broadcasters?.find((item) => item?.is_host)
    || station?.broadcast?.broadcasters?.[0]
    || null;
  const rawTracks = queue?.queue_tracks ?? queue?.tracks ?? [];
  if (!Array.isArray(rawTracks)) {
    throw new Error('Stationhead buddy playback queue tracks are not an array');
  }
  const tracks = rawTracks.slice(0, maxTracks).map((item, index) => {
    const track = item?.track || item || {};
    return {
      position: finiteNumber(item?.position, index),
      queue_track_id: finiteNumber(item?.id),
      stationhead_track_id: finiteNumber(track?.id),
      spotify_id: String(track?.spotify_id || '').trim() || null,
      apple_music_id: String(track?.apple_music_id || '').trim() || null,
      deezer_id: String(track?.deezer_id || '').trim() || null,
      isrc: String(track?.isrc || '').trim() || null,
      duration_ms: Math.max(0, finiteNumber(track?.duration, 0)),
      preview_url: track?.preview || null,
    };
  });
  return {
    channel_alias: alias,
    station_id: finiteNumber(queue?.station_id ?? station?.id ?? channel?.current_station_id),
    queue_id: finiteNumber(queue?.id),
    start_time: finiteNumber(queue?.start_time),
    is_paused: booleanValue(queue?.is_paused),
    is_broadcasting: booleanValue(station?.is_broadcasting ?? channel?.is_broadcasting),
    host_account_id: finiteNumber(host?.account_id ?? host?.account?.id),
    host_handle: String(host?.account?.handle || '').trim() || null,
    tracks,
  };
}

function currentIndex(queue, now) {
  if (!queue.tracks.length) return -1;
  if (!queue.start_time) return 0;
  const elapsed = Math.max(0, now - queue.start_time);
  let cursor = 0;
  for (let index = 0; index < queue.tracks.length; index += 1) {
    const duration = Math.max(0, finiteNumber(queue.tracks[index]?.duration_ms, 0));
    if (elapsed < cursor + duration || index === queue.tracks.length - 1) return index;
    cursor += duration;
  }
  return queue.tracks.length - 1;
}

async function loadTrackMetadata(db, spotifyIds) {
  if (!spotifyIds.length) return new Map();
  const placeholders = spotifyIds.map(() => '?').join(',');
  const result = await db.prepare(`SELECT spotify_id,title,artist,display_title,
      thumbnail_url,spotify_url,fetched_at
    FROM sh_track_metadata WHERE spotify_id IN (${placeholders})`)
    .bind(...spotifyIds).all();
  return new Map((result.results || []).map((row) => [String(row.spotify_id), row]));
}

async function saveTrackMetadata(db, rows) {
  if (!rows.length) return;
  await db.batch(rows.map((row) => db.prepare(`INSERT INTO sh_track_metadata (
      spotify_id,title,artist,display_title,thumbnail_url,spotify_url,source,fetched_at,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(spotify_id) DO UPDATE SET
      title=excluded.title,artist=excluded.artist,display_title=excluded.display_title,
      thumbnail_url=COALESCE(excluded.thumbnail_url,sh_track_metadata.thumbnail_url),
      spotify_url=excluded.spotify_url,source=excluded.source,
      fetched_at=excluded.fetched_at,raw_json=excluded.raw_json`)
    .bind(
      row.spotify_id,
      row.title,
      row.artist,
      row.display_title,
      row.thumbnail_url,
      row.spotify_url,
      row.source,
      row.fetched_at,
      JSON.stringify(row.raw || {}),
    )));
}

async function enrichQueueMetadata(env, queue, now, config, fetchMetadata = fetchTrackMetadata) {
  const spotifyIds = [...new Set(queue.tracks.map((track) => track.spotify_id).filter(Boolean))];
  const metadata = await loadTrackMetadata(env.DB, spotifyIds);
  if (!spotifyIds.length || config.metadataLimit <= 0) return metadata;

  const index = currentIndex(queue, now);
  const ordered = [
    ...queue.tracks.slice(Math.max(0, index)),
    ...queue.tracks.slice(0, Math.max(0, index)),
  ];
  const missing = [];
  const seen = new Set();
  for (const track of ordered) {
    const spotifyId = track.spotify_id;
    if (!spotifyId || seen.has(spotifyId) || metadataRetryBlocked(spotifyId, now)) continue;
    seen.add(spotifyId);
    if (metadataNeedsRefresh(metadata.get(spotifyId), spotifyId, now)) missing.push(track);
    if (missing.length >= config.metadataLimit) break;
  }

  const fetched = [];
  for (const track of missing) {
    let row = null;
    try {
      row = await fetchMetadata(track, config);
    } catch {
      row = null;
    }
    if (!row) {
      markMetadataFailure(track.spotify_id, now);
      continue;
    }
    metadataFailureUntil.delete(track.spotify_id);
    fetched.push(row);
    metadata.set(String(row.spotify_id), row);
  }
  await saveTrackMetadata(env.DB, fetched);
  return metadata;
}

export function attachBuddyMetadata(queue, metadata) {
  return queue.tracks.map((track) => {
    const row = track.spotify_id ? metadata.get(String(track.spotify_id)) : null;
    const title = String(row?.title || '').trim() || null;
    const artist = String(row?.artist || '').trim() || null;
    return {
      ...track,
      title,
      artist,
      display_title: row?.display_title || (title && artist ? `${title} — ${artist}` : title),
      thumbnail_url: row?.thumbnail_url || null,
      spotify_url: row?.spotify_url
        || (track.spotify_id ? `https://open.spotify.com/track/${track.spotify_id}` : null),
    };
  });
}

async function stateHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function collectBuddyPlayback(env, now = Date.now(), dependencies = {}) {
  if (!env?.DB) return { skipped: true, reason: 'db-binding-missing' };
  const config = buddyPlaybackConfig(env);
  if (!config.enabled) return { skipped: true, reason: 'disabled' };

  let current;
  try {
    current = await env.DB.prepare(BUDDY_PLAYBACK_SELECT_SQL).bind(config.alias).first();
  } catch (error) {
    if (missingTable(error)) return { skipped: true, reason: 'playback-table-setup-required' };
    throw error;
  }

  const session = await (dependencies.loadSession || loadSession)(env);
  const channel = validateBuddyChannelPayload(await (dependencies.fetchChannel || fetchChannel)(
    env,
    session,
    config,
    dependencies.fetch,
  ), config.alias);
  const queue = extractBuddyPlayback(channel, config.alias, config.maxTracks);
  const metadata = await enrichQueueMetadata(
    env,
    queue,
    now,
    config,
    dependencies.fetchTrackMetadata,
  );
  const tracks = attachBuddyMetadata(queue, metadata);
  const playbackState = {
    station_id: queue.station_id,
    queue_id: queue.queue_id,
    start_time: queue.start_time,
    is_paused: queue.is_paused,
    is_broadcasting: queue.is_broadcasting,
    host_account_id: queue.host_account_id,
    host_handle: queue.host_handle,
    tracks: queue.tracks,
  };
  const hash = await (dependencies.stateHash || stateHash)(playbackState);
  const queueJson = JSON.stringify(tracks);
  const playbackChanged = current?.state_hash !== hash;
  const contentChanged = current?.queue_json !== queueJson;

  if (!playbackChanged && !contentChanged) {
    await env.DB.prepare(BUDDY_PLAYBACK_TOUCH_SQL).bind(now, config.alias).run();
  } else {
    const changedAt = playbackChanged ? now : finiteNumber(current?.changed_at, now);
    await env.DB.prepare(BUDDY_PLAYBACK_UPSERT_SQL).bind(
      config.alias,
      queue.station_id,
      queue.queue_id,
      queue.start_time,
      queue.is_paused ? 1 : 0,
      queue.is_broadcasting ? 1 : 0,
      queue.host_account_id,
      queue.host_handle,
      hash,
      queueJson,
      now,
      changedAt,
    ).run();
  }

  return {
    skipped: false,
    channel_alias: config.alias,
    changed: playbackChanged || contentChanged,
    playback_changed: playbackChanged,
    content_changed: contentChanged,
    tracks: tracks.length,
    checked_at: now,
  };
}

export function runBuddyPlayback(env, now = Date.now(), dependencies = {}) {
  const config = buddyPlaybackConfig(env);
  if (!config.enabled) return Promise.resolve({ skipped: true, reason: 'disabled' });
  if (!shouldRunBuddyPlayback(now, config.intervalMs)) {
    return Promise.resolve({ skipped: true, reason: 'not-due' });
  }
  if (buddyPlaybackFlight) return buddyPlaybackFlight;
  buddyPlaybackFlight = Promise.resolve()
    .then(() => collectBuddyPlayback(env, now, dependencies))
    .finally(() => { buddyPlaybackFlight = null; });
  return buddyPlaybackFlight;
}

export function resetBuddyPlaybackFlight() {
  buddyPlaybackFlight = null;
  metadataFailureUntil.clear();
}
