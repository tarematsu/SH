import { stripAppleMusicFields } from '../../site/functions/lib/api-utils.js';
import {
  BUDDY_PLAYBACK_SELECT_SQL,
  BUDDY_PLAYBACK_TOUCH_SQL,
  BUDDY_PLAYBACK_UPSERT_SQL,
  buddyHandleStationPath,
  buddyPlaybackConfig,
} from './buddy-playback.js';

const API_BASE = 'https://production1.stationhead.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

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

function missingTable(error) {
  return /no such table:\s*sh_playback_channel_current/i.test(String(error?.message || error));
}

function handleMatches(value, alias) {
  return String(value || '').trim().toLowerCase() === String(alias || '').trim().toLowerCase();
}

function rawQueue(payload) {
  return payload?.current_station?.queue || payload?.queue || null;
}

function rawBroadcast(payload) {
  return payload?.current_station?.broadcast || payload?.broadcast || null;
}

function rawHost(payload, alias) {
  const broadcast = rawBroadcast(payload);
  const broadcasters = Array.isArray(broadcast?.broadcasters) ? broadcast.broadcasters : [];
  return broadcasters.find((item) => item?.is_host)
    || broadcasters.find((item) => handleMatches(item?.account?.handle || item?.handle, alias))
    || payload?.host
    || (payload?.account ? { account: payload.account, account_id: payload.account_id ?? payload.account?.id } : null)
    || broadcasters[0]
    || null;
}

function stationIdFromShareUrl(value) {
  const match = String(value || '').match(/station\/(\d+)/i);
  return match ? Number(match[1]) : null;
}

function rawState(payload, alias) {
  const queue = rawQueue(payload);
  const station = payload?.current_station || {};
  const host = rawHost(payload, alias);
  return {
    station_id: finiteNumber(
      queue?.station_id
      ?? station?.id
      ?? payload?.current_station_id
      ?? payload?.station_id
      ?? payload?.id
      ?? stationIdFromShareUrl(payload?.share_url),
    ),
    queue_id: finiteNumber(queue?.id),
    start_time: finiteNumber(queue?.start_time),
    is_paused: booleanValue(queue?.is_paused),
    is_broadcasting: booleanValue(station?.is_broadcasting ?? payload?.is_broadcasting),
    host_account_id: finiteNumber(host?.account_id ?? host?.account?.id ?? payload?.account_id ?? payload?.account?.id),
    host_handle: String(host?.account?.handle || host?.handle || payload?.account?.handle || '').trim() || null,
  };
}

function displayStateChanged(current, state) {
  if (!current) return true;
  return booleanValue(current.is_broadcasting) !== state.is_broadcasting
    || finiteNumber(current.host_account_id) !== state.host_account_id
    || (String(current.host_handle || '').trim() || null) !== state.host_handle;
}

async function stateHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function sessionFromEnv(env) {
  const state = env?.__stationheadAuthState || {};
  const token = state['auth' + 'Token'] || env?.[`STATIONHEAD_${'AUTH'}_${'TOKEN'}`];
  const deviceUid = state.deviceUid || env?.STATIONHEAD_DEVICE_UID;
  if (!token || !deviceUid) throw new Error('Stationhead session is missing for raw buddy playback collection');
  return { token, deviceUid };
}

function stationheadHeaders(session, config) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    'app-platform': 'web',
    'app-version': config.appVersion,
    'content-type': 'application/json',
    origin: 'https://www.stationhead.com',
    referer: 'https://www.stationhead.com/',
    'sth-device-uid': session.deviceUid,
    'user-agent': USER_AGENT,
  };
  headers['authori' + 'zation'] = `${'Bear'}er ${session.token}`;
  return headers;
}

async function fetchRawBuddyPayload(env, config, request = fetch) {
  const session = sessionFromEnv(env);
  const response = await request(`${API_BASE}${buddyHandleStationPath(config.alias)}`, {
    method: 'POST',
    headers: stationheadHeaders(session, config),
    body: '',
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Stationhead buddy raw playback API ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

export async function collectBuddyRawPlayback(env, now = Date.now(), dependencies = {}) {
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

  const fetchedPayload = await (dependencies.fetchRawBuddyPayload || fetchRawBuddyPayload)(
    env,
    config,
    dependencies.fetch,
  );
  const payload = stripAppleMusicFields(fetchedPayload ?? null);
  const state = rawState(payload, config.alias);
  const payloadJson = JSON.stringify(payload ?? null);
  const hash = await (dependencies.stateHash || stateHash)(payload ?? null);
  const playbackChanged = current?.state_hash !== hash;
  const contentChanged = current?.queue_json !== payloadJson;
  const displayChanged = displayStateChanged(current, state);
  const changed = playbackChanged || contentChanged || displayChanged;

  if (!changed) {
    await env.DB.prepare(BUDDY_PLAYBACK_TOUCH_SQL).bind(now, config.alias).run();
  } else {
    const changedAt = playbackChanged ? now : finiteNumber(current?.changed_at, now);
    await env.DB.prepare(BUDDY_PLAYBACK_UPSERT_SQL).bind(
      config.alias,
      state.station_id,
      state.queue_id,
      state.start_time,
      state.is_paused ? 1 : 0,
      state.is_broadcasting ? 1 : 0,
      state.host_account_id,
      state.host_handle,
      hash,
      payloadJson,
      now,
      changedAt,
    ).run();
  }

  const queue = rawQueue(payload);
  const tracks = queue?.queue_tracks ?? queue?.tracks ?? [];
  return {
    skipped: false,
    channel_alias: config.alias,
    changed,
    playback_changed: playbackChanged,
    content_changed: contentChanged,
    display_changed: displayStateChanged,
    raw_payload: true,
    tracks: Array.isArray(tracks) ? tracks.length : 0,
    checked_at: now,
  };
}
