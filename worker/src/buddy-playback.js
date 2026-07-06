import {
  fetchTrackMetadata,
  jwtExpiryMs,
  metadataNeedsRefresh,
  normalizeBearer,
} from './shared.js';

const API_BASE = 'https://production1.stationhead.com';
const DEFAULT_ALIAS = 'buddy46';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_TRACKS = 80;
const DEFAULT_METADATA_LIMIT = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export const BUDDY_PLAYBACK_SELECT_SQL = `SELECT state_hash,checked_at
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

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

export function buddyPlaybackConfig(env = {}) {
  return {
    enabled: enabled(env.BUDDY_PLAYBACK_ENABLED),
    alias: String(env.BUDDY_PLAYBACK_ALIAS || DEFAULT_ALIAS).trim() || DEFAULT_ALIAS,
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
    if (authToken && deviceUid) return { authToken, deviceUid, persisted: false };
  }

  const row = await env.DB.prepare(`SELECT auth_token,device_uid
    FROM sh_worker_collector_state WHERE id='stationhead'`).first();
  const authToken = normalizeBearer(row?.auth_token || env.STATIONHEAD_AUTH_TOKEN);
  const deviceUid = String(row?.device_uid || env.STATIONHEAD_DEVICE_UID || '').trim();
  if (!authToken || !deviceUid) {
    throw new Error('Stationhead session is missing for buddy46 playback collection');
  }
  return { authToken, deviceUid, persisted: Boolean(row) };
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

async function persistRefreshedToken(env, session, refreshed) {
  if (!refreshed || refreshed === session.authToken) return;
  session.authToken = refreshed;
  const expiresAt = jwtExpiryMs(refreshed) || null;
  if (env.__stationheadAuthState) {
    env.__stationheadAuthState.authToken = refreshed;
    env.__stationheadAuthState.tokenExpiresAt = expiresAt;
  }
  if (!env.DB) return;
  await env.DB.prepare(`UPDATE sh_worker_collector_state
    SET auth_token=?,token_expires_at=?,updated_at=? WHERE id='stationhead'`)
    .bind(refreshed, expiresAt, Date.now()).run();
}

async function fetchChannel(env, session, config, request = fetch) {
  const response = await request(
    `${API_BASE}/channels/alias/${encodeURIComponent(config.alias)}`,
    {
      headers: stationheadHeaders(session, config),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    },
  );
  const refreshed = normalizeBearer(response.headers.get('authorization'));
  if (refreshed && refreshed !== session.authToken) {
    await persistRefreshedToken(env, session, refreshed);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Stationhead buddy playback API ${response.status}: ${body.slice(0, 200)}`);
  }
  const channel = await response.json();
  const actualAlias = String(channel?.alias || channel?.channel_alias || '').trim();
  if (actualAlias && actualAlias.toLowerCase() !== config.alias.toLowerCase()) {
    throw new Error(`Stationhead alias mismatch: expected ${config.alias}, received ${actualAlias}`);
  }
  return channel;
}

export function extractBuddyPlayback(channel, alias = DEFAULT_ALIAS, maxTracks = DEFAULT_MAX_TRACKS) {
  const station = channel?.current_station || {};
  const queue = station?.queue || channel?.queue || null;
  const host = station?.broadcast?.broadcasters?.find((item) => item?.is_host)
    || station?.broadcast?.broadcasters?.[0]
    || null;
  const sourceTracks = queue?.queue_tracks || queue?.tracks || [];
  const tracks = sourceTracks.slice(0, maxTracks).map((item, index) => {
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
      bite_count: finiteNumber(track?.bite_count),
    };
  });
  return {
    channel_alias: alias,
    station_id: finiteNumber(queue?.station_id ?? station?.id ?? channel?.current_station_id),
    queue_id: finiteNumber(queue?.id),
    start_time: finiteNumber(queue?.start_time),
    is_paused: Boolean(queue?.is_paused),
    is_broadcasting: station?.is_broadcasting === true || station?.is_broadcasting === 1,
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
      thumbnail_url,spotify_url,fetched_at,raw_json
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
    if (!spotifyId || seen.has(spotifyId)) continue;
    seen.add(spotifyId);
    if (metadataNeedsRefresh(metadata.get(spotifyId), spotifyId, now)) missing.push(track);
    if (missing.length >= config.metadataLimit) break;
  }

  const fetched = [];
  for (const track of missing) {
    const row = await fetchMetadata(track, config);
    if (!row) continue;
    fetched.push(row);
    metadata.set(String(row.spotify_id), {
      ...row,
      raw_json: JSON.stringify(row.raw || {}),
    });
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
      metadata_fetched_at: finiteNumber(row?.fetched_at),
      metadata_raw_json: row?.raw_json || null,
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

  const session = await (dependencies.loadSession || loadSession)(env);
  const channel = await (dependencies.fetchChannel || fetchChannel)(
    env,
    session,
    config,
    dependencies.fetch,
  );
  const queue = extractBuddyPlayback(channel, config.alias, config.maxTracks);
  const metadata = await enrichQueueMetadata(
    env,
    queue,
    now,
    config,
    dependencies.fetchTrackMetadata,
  );
  const tracks = attachBuddyMetadata(queue, metadata);
  const state = {
    station_id: queue.station_id,
    queue_id: queue.queue_id,
    start_time: queue.start_time,
    is_paused: queue.is_paused,
    is_broadcasting: queue.is_broadcasting,
    host_account_id: queue.host_account_id,
    host_handle: queue.host_handle,
    tracks,
  };
  const hash = await (dependencies.stateHash || stateHash)(state);
  const current = await env.DB.prepare(BUDDY_PLAYBACK_SELECT_SQL).bind(config.alias).first();
  const changed = current?.state_hash !== hash;

  if (!changed) {
    await env.DB.prepare(BUDDY_PLAYBACK_TOUCH_SQL).bind(now, config.alias).run();
  } else {
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
      JSON.stringify(tracks),
      now,
      now,
    ).run();
  }

  return {
    skipped: false,
    channel_alias: config.alias,
    changed,
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
}
