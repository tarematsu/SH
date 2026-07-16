import { normalizeBuddyQueuePayload } from './buddy-fetch-guard.js';
import { normalizeBearer } from './shared.js';
import {
  extractBuddyPlayback,
  validateBuddyChannelPayload,
} from './buddy-playback-queue.js';
import {
  attachBuddyMetadata,
  enrichQueueMetadata,
  resetMetadataFailureCache,
} from './buddy-playback-metadata.js';

const API_BASE = 'https://production1.stationhead.com';
const DEFAULT_ALIAS = 'buddy46';
const DEFAULT_AUTH_STATE_ID = 'buddy46';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_TRACKS = 80;
const DEFAULT_METADATA_LIMIT = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export { extractBuddyPlayback, validateBuddyChannelPayload, attachBuddyMetadata };

export const BUDDY_PLAYBACK_SELECT_SQL = `SELECT p.station_id,p.queue_id,p.start_time,p.is_paused,
  p.is_broadcasting,p.host_account_id,p.host_handle,p.state_hash,p.queue_json,
  p.checked_at,p.changed_at,c.queue_id AS clock_queue_id,
  c.start_time AS clock_start_time,c.is_paused AS clock_is_paused,
  c.paused_total_ms,c.pause_started_at,c.observed_at AS clock_observed_at
  FROM sh_playback_channel_current p
  LEFT JOIN sh_buddy_playback_clock c ON c.channel_alias=p.channel_alias
  WHERE p.channel_alias=?`;

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

export const BUDDY_PLAYBACK_CLOCK_UPSERT_SQL = `INSERT INTO sh_buddy_playback_clock (
  channel_alias,queue_id,start_time,is_paused,paused_total_ms,pause_started_at,observed_at
) VALUES (?,?,?,?,?,?,?)
ON CONFLICT(channel_alias) DO UPDATE SET
  queue_id=excluded.queue_id,
  start_time=excluded.start_time,
  is_paused=excluded.is_paused,
  paused_total_ms=excluded.paused_total_ms,
  pause_started_at=excluded.pause_started_at,
  observed_at=excluded.observed_at`;

let buddyPlaybackFlight = null;

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

function buddyAuthStateId(env = {}) {
  return String(env.BUDDY_PLAYBACK_AUTH_STATE_ID || DEFAULT_AUTH_STATE_ID).trim().toLowerCase()
    || DEFAULT_AUTH_STATE_ID;
}

function buddyScopedCredentials(env = {}) {
  return {
    authToken: env.BUDDY_PLAYBACK_AUTH_TOKEN || env.BUDDY46_AUTH_TOKEN,
    deviceUid: env.BUDDY_PLAYBACK_DEVICE_UID || env.BUDDY46_DEVICE_UID,
  };
}

export function buddyHandleStationPath(alias = DEFAULT_ALIAS) {
  return `/station/handle/${encodeURIComponent(String(alias || DEFAULT_ALIAS).trim().toLowerCase() || DEFAULT_ALIAS)}/guest`;
}

export function buddyPlaybackConfig(env = {}) {
  return {
    enabled: enabled(env.BUDDY_PLAYBACK_ENABLED),
    alias: String(env.BUDDY_PLAYBACK_ALIAS || DEFAULT_ALIAS).trim().toLowerCase() || DEFAULT_ALIAS,
    authStateId: buddyAuthStateId(env),
    intervalMs: positiveInteger(env.BUDDY_PLAYBACK_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    maxTracks: positiveInteger(env.BUDDY_PLAYBACK_MAX_TRACKS, DEFAULT_MAX_TRACKS, 80),
    metadataLimit: positiveInteger(
      env.BUDDY_PLAYBACK_METADATA_LIMIT,
      DEFAULT_METADATA_LIMIT,
      10,
    ),
    requestTimeoutMs: positiveInteger(
      env.REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      30_000,
    ),
    appVersion: String(env.STATIONHEAD_APP_VERSION || env.SH_APP_VERSION || '1.0.0'),
  };
}

export function shouldRunBuddyPlayback(now = Date.now(), intervalMs = DEFAULT_INTERVAL_MS) {
  const interval = Math.max(60_000, positiveInteger(intervalMs, DEFAULT_INTERVAL_MS));
  const minute = Math.floor(now / 60_000);
  const intervalMinutes = Math.max(1, Math.round(interval / 60_000));
  return minute % intervalMinutes === 0;
}

async function loadSession(env) {
  const cached = env.__buddyAuthState;
  if (cached) {
    const authToken = normalizeBearer(cached.authToken || buddyScopedCredentials(env).authToken);
    const deviceUid = String(cached.deviceUid || buddyScopedCredentials(env).deviceUid || '').trim();
    if (authToken && deviceUid) return { authToken, deviceUid };
  }

  const config = buddyPlaybackConfig(env);
  const row = await env.OTHER_DB.prepare(`SELECT auth_token,device_uid
    FROM sh_worker_collector_state WHERE id=?`).bind(config.authStateId).first();
  const fallback = buddyScopedCredentials(env);
  const authToken = normalizeBearer(row?.auth_token || fallback.authToken);
  const deviceUid = String(row?.device_uid || fallback.deviceUid || '').trim();
  if (!authToken || !deviceUid) {
    throw new Error('buddy46 session is missing for playback collection');
  }
  return { authToken, deviceUid };
}

function shHeaders(session, config) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    ['authori' + 'zation']: `${['Bear', 'er'].join('')} ${session.authToken}`,
    'app-platform': 'web',
    'app-version': config.appVersion,
    'content-type': 'application/json',
    origin: 'https://www.stationhead.com',
    referer: 'https://www.stationhead.com/',
    'sth-device-uid': session.deviceUid,
    'user-agent': USER_AGENT,
  };
}

async function fetchChannel(env, session, config, request = fetch) {
  const response = await request(
    `${API_BASE}${buddyHandleStationPath(config.alias)}`,
    {
      method: 'POST',
      headers: shHeaders(session, config),
      body: '',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Stationhead buddy playback API ${response.status}: ${body.slice(0, 200)}`);
  }
  const payload = normalizeBuddyQueuePayload(await response.json(), config.alias);
  return validateBuddyChannelPayload(payload, config.alias);
}

async function stateHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function displayStateChanged(current, queue) {
  if (!current) return true;
  return booleanValue(current.is_broadcasting) !== queue.is_broadcasting
    || finiteNumber(current.host_account_id) !== queue.host_account_id
    || (String(current.host_handle || '').trim() || null) !== queue.host_handle;
}

function sameQueue(current, queue) {
  if (!current) return false;
  const currentQueueId = finiteNumber(current.clock_queue_id ?? current.queue_id);
  const currentStartTime = finiteNumber(current.clock_start_time ?? current.start_time);
  const queueId = finiteNumber(queue?.queue_id);
  const startTime = finiteNumber(queue?.start_time);
  if (queueId == null && startTime == null) return false;
  return currentQueueId === queueId && currentStartTime === startTime;
}

export function buddyPlaybackClock(current, queue, now = Date.now()) {
  const paused = booleanValue(queue?.is_paused);
  if (!sameQueue(current, queue)) {
    return {
      queue_id: finiteNumber(queue?.queue_id),
      start_time: finiteNumber(queue?.start_time),
      is_paused: paused ? 1 : 0,
      paused_total_ms: 0,
      pause_started_at: paused ? now : null,
      observed_at: now,
    };
  }

  const wasPaused = booleanValue(current?.clock_is_paused ?? current?.is_paused);
  let pausedTotalMs = Math.max(0, finiteNumber(current?.paused_total_ms, 0));
  let pauseStartedAt = finiteNumber(current?.pause_started_at);
  if (wasPaused && pauseStartedAt == null) pauseStartedAt = finiteNumber(current?.changed_at, now);
  if (!wasPaused && paused) pauseStartedAt = now;
  if (wasPaused && !paused) {
    if (pauseStartedAt != null) pausedTotalMs += Math.max(0, now - pauseStartedAt);
    pauseStartedAt = null;
  }

  return {
    queue_id: finiteNumber(queue?.queue_id),
    start_time: finiteNumber(queue?.start_time),
    is_paused: paused ? 1 : 0,
    paused_total_ms: pausedTotalMs,
    pause_started_at: pauseStartedAt,
    observed_at: now,
  };
}

function clockStatement(db, alias, clock) {
  return db.prepare(BUDDY_PLAYBACK_CLOCK_UPSERT_SQL).bind(
    alias,
    clock.queue_id,
    clock.start_time,
    clock.is_paused,
    clock.paused_total_ms,
    clock.pause_started_at,
    clock.observed_at,
  );
}

export async function collectBuddyPlayback(env, now = Date.now(), dependencies = {}) {
  if (!env?.OTHER_DB) return { skipped: true, reason: 'db-binding-missing' };
  const config = buddyPlaybackConfig(env);
  if (!config.enabled) return { skipped: true, reason: 'disabled' };

  let current;
  try {
    current = await env.OTHER_DB.prepare(BUDDY_PLAYBACK_SELECT_SQL).bind(config.alias).first();
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
    tracks: queue.tracks,
  };
  const hash = await (dependencies.stateHash || stateHash)(playbackState);
  const queueJson = JSON.stringify(tracks);
  const playbackChanged = current?.state_hash !== hash;
  const contentChanged = current?.queue_json !== queueJson;
  const displayChanged = displayStateChanged(current, queue);
  const changed = playbackChanged || contentChanged || displayChanged;
  const clock = buddyPlaybackClock(current, queue, now);

  if (!changed) {
    await env.OTHER_DB.batch([
      env.OTHER_DB.prepare(BUDDY_PLAYBACK_TOUCH_SQL).bind(now, config.alias),
      clockStatement(env.OTHER_DB, config.alias, clock),
    ]);
  } else {
    const changedAt = playbackChanged ? now : finiteNumber(current?.changed_at, now);
    await env.OTHER_DB.batch([
      env.OTHER_DB.prepare(BUDDY_PLAYBACK_UPSERT_SQL).bind(
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
      ),
      clockStatement(env.OTHER_DB, config.alias, clock),
    ]);
  }

  return {
    skipped: false,
    channel_alias: config.alias,
    changed,
    playback_changed: playbackChanged,
    content_changed: contentChanged,
    display_changed: displayChanged,
    tracks: tracks.length,
    checked_at: now,
    paused_total_ms: clock.paused_total_ms,
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
  resetMetadataFailureCache();
}
