import { onRequestPost as saveHostIngest } from '../../site/functions/api/host-ingest.js';
import { onRequestPost as savePrimaryIngest } from '../../site/functions/api/ingest.js';
import {
  positiveNumber as positive,
  enrichTracks as sharedEnrichTracks,
} from './shared.js';
import {
  finite,
  identity,
  normalizeProfile,
  normalizeComments,
  normalizeQueue,
  queueHash,
} from './cloud-host-monitor-normalize.js';

const API_BASE = 'https://production1.stationhead.com';
const COLLECTOR_ID = 'cloudflare-worker';
const SOURCE_PRIORITY = 100;

function cfg(env) {
  return {
    profileHandle: env.HOST_PROFILE_HANDLE || 'sakuramankai',
    profileAccountId: finite(env.HOST_PROFILE_ACCOUNT_ID) || 3334889,
    profileIntervalMs: positive(env.HOST_PROFILE_INTERVAL_MS, 60 * 60 * 1000),
    soloHandle: env.SOLO_BROADCAST_HANDLE || 'sakurazaka46jp',
    soloAccountId: finite(env.SOLO_BROADCAST_ACCOUNT_ID),
    soloConfirmPolls: positive(env.SOLO_CONFIRM_POLLS, 2),
    soloEndConfirmPolls: positive(env.SOLO_END_CONFIRM_POLLS, 3),
    soloChatLimit: Math.min(positive(env.SOLO_CHAT_LIMIT, 50), 100),
    soloProfileIntervalMs: positive(env.SOLO_PROFILE_INTERVAL_MS, 60 * 60 * 1000),
    officialEarlyWindowMs: positive(env.OFFICIAL_NEWS_EARLY_WINDOW_MS, 10 * 60 * 1000),
    officialLateWindowMs: positive(env.OFFICIAL_NEWS_LATE_WINDOW_MS, 90 * 60 * 1000),
    metadataLimit: Math.min(positive(env.METADATA_LIMIT, 3), 10),
    requestTimeoutMs: Math.min(positive(env.REQUEST_TIMEOUT_MS, 20000), 30000),
    appVersion: env.STATIONHEAD_APP_VERSION || env.SH_APP_VERSION || '1.0.0',
  };
}

function headers(config, session) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    'app-platform': 'web',
    'app-version': config.appVersion,
    'content-type': 'application/json',
    origin: 'https://www.stationhead.com',
    referer: 'https://www.stationhead.com/',
    'sth-device-uid': session.device_uid,
    authorization: `Bearer ${session.auth_token}`,
  };
}

async function session(env) {
  const row = await env.DB.prepare(`SELECT auth_token,device_uid
    FROM sh_worker_collector_state WHERE id='stationhead'`).first();
  if (!row?.auth_token || !row?.device_uid) throw new Error('Stationhead cloud session unavailable');
  return row;
}

async function stationRequest(path, config, auth, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers(config, auth), ...(options.headers || {}) },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Stationhead ${response.status}: ${path}${body ? ` | ${body.slice(0, 180)}` : ''}`);
  }
  return response.json();
}

async function internalIngest(handler, env, type, data, observedAt) {
  const secret = env.INGEST_SECRET || 'worker-internal-ingest';
  const request = new Request('https://worker.internal/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type,
      observed_at: observedAt,
      collector_id: COLLECTOR_ID,
      collector_kind: 'cloud',
      source_priority: SOURCE_PRIORITY,
      data,
    }),
  });
  const response = await handler({ request, env: { ...env, INGEST_SECRET: secret } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(`${type} ingest failed ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

async function stateRow(env, id) {
  return env.OTHER_DB.prepare(`SELECT * FROM sh_cloud_host_monitor_state WHERE id=?`).bind(id).first();
}

async function saveState(env, id, values) {
  const now = Date.now();
  await env.OTHER_DB.prepare(`INSERT INTO sh_cloud_host_monitor_state (
      id,session_id,station_id,phase,candidate_count,inactive_count,
      last_profile_at,last_queue_hash,last_success_at,last_error,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      session_id=excluded.session_id,station_id=excluded.station_id,
      phase=excluded.phase,candidate_count=excluded.candidate_count,
      inactive_count=excluded.inactive_count,last_profile_at=excluded.last_profile_at,
      last_queue_hash=excluded.last_queue_hash,last_success_at=excluded.last_success_at,
      last_error=excluded.last_error,updated_at=excluded.updated_at`)
    .bind(
      id,
      values.sessionId ?? null,
      values.stationId ?? null,
      values.phase || 'idle',
      Number(values.candidateCount || 0),
      Number(values.inactiveCount || 0),
      values.lastProfileAt ?? null,
      values.lastQueueHash ?? null,
      values.lastSuccessAt ?? null,
      values.lastError ?? null,
      now,
    ).run();
}

async function recoverSoloState(env, config) {
  const id = `solo:${config.soloHandle}`;
  const stored = await stateRow(env, id);
  if (stored) {
    return {
      id,
      sessionId: finite(stored.session_id),
      stationId: finite(stored.station_id),
      phase: stored.phase || 'idle',
      candidateCount: Number(stored.candidate_count || 0),
      inactiveCount: Number(stored.inactive_count || 0),
      lastProfileAt: finite(stored.last_profile_at) || 0,
      lastQueueHash: stored.last_queue_hash || null,
    };
  }

  const sessionRow = await env.OTHER_DB.prepare(`SELECT id,station_id,status,last_observed_at
    FROM sh_host_broadcast_sessions
    WHERE source_scope='sakurazaka46jp_solo' AND handle=?
      AND status IN ('provisional','active')
    ORDER BY started_at DESC LIMIT 1`).bind(config.soloHandle).first();
  return {
    id,
    sessionId: finite(sessionRow?.id),
    stationId: finite(sessionRow?.station_id),
    phase: sessionRow?.status || 'idle',
    candidateCount: sessionRow?.status === 'active' ? config.soloConfirmPolls : 0,
    inactiveCount: 0,
    lastProfileAt: 0,
    lastQueueHash: null,
  };
}

export async function shouldProbeSolo(env, config, state, now = Date.now()) {
  if (state?.sessionId || state?.phase === 'provisional' || state?.phase === 'active') return true;
  try {
    const due = await env.OTHER_DB.prepare(`SELECT 1 AS due
      FROM sh_official_news_announcements
      WHERE scheduled_at IS NOT NULL AND (
        (status='scheduled' AND scheduled_at>=? AND scheduled_at<=?)
        OR status='active'
      )
      LIMIT 1`)
      .bind(now - config.officialLateWindowMs, now + config.officialEarlyWindowMs)
      .first();
    return Boolean(due?.due);
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return false;
    throw error;
  }
}

async function account(env, config, auth, accountId) {
  if (!accountId) return null;
  const channel = await env.DB.prepare(`SELECT channel_id FROM sh_channel_snapshots
    ORDER BY observed_at DESC LIMIT 1`).first();
  const channelId = finite(channel?.channel_id) || 318;
  const payload = await stationRequest(
    `/account?ids=${encodeURIComponent(accountId)}&channelId=${encodeURIComponent(channelId)}`,
    config,
    auth,
  );
  return payload?.accounts?.[0] || null;
}

async function collectGeneralProfile(env, config, auth, now) {
  const id = `profile:${config.profileHandle}`;
  const state = await stateRow(env, id);
  if (state?.last_profile_at && now - Number(state.last_profile_at) < config.profileIntervalMs) return;

  let accountId = config.profileAccountId;
  if (!accountId) {
    const station = await stationRequest(`/station/handle/${encodeURIComponent(config.profileHandle)}/guest`, config, auth, {
      method: 'POST',
      body: '{}',
    });
    accountId = identity(station).accountId;
  }
  const profile = normalizeProfile(await account(env, config, auth, accountId), config.profileHandle);
  if (!profile?.handle) throw new Error(`profile unavailable for @${config.profileHandle}`);
  await internalIngest(saveHostIngest, env, 'host_profile_snapshot', profile, now);
  await saveState(env, id, {
    phase: 'idle',
    lastProfileAt: now,
    lastSuccessAt: now,
    lastError: null,
  });
}

async function enrichTracks(env, config, queue, now) {
  const ingestFn = (e, type, data, observedAt) => internalIngest(savePrimaryIngest, e, type, data, observedAt);
  await sharedEnrichTracks(env, ingestFn, queue, now, config);
}

async function collectSoloProfile(env, config, auth, state, accountId, now) {
  if (!accountId || now - state.lastProfileAt < config.soloProfileIntervalMs) return state.lastProfileAt;
  const profile = normalizeProfile(await account(env, config, auth, accountId), config.soloHandle);
  if (!profile?.handle) return state.lastProfileAt;
  await internalIngest(saveHostIngest, env, 'host_profile_snapshot', {
    ...profile,
    session_id: state.sessionId,
    source_scope: 'sakurazaka46jp_solo',
  }, now);
  return now;
}

async function closeSolo(env, config, auth, state, station, now, status, reason) {
  let profile = null;
  const accountId = identity(station).accountId || config.soloAccountId;
  if (accountId) {
    profile = normalizeProfile(await account(env, config, auth, accountId).catch(() => null), config.soloHandle);
    if (profile) {
      await internalIngest(saveHostIngest, env, 'host_profile_snapshot', {
        ...profile,
        session_id: state.sessionId,
        source_scope: 'sakurazaka46jp_solo',
      }, now);
    }
  }
  await internalIngest(saveHostIngest, env, 'solo_session_close', {
    session_id: state.sessionId,
    ended_at: now,
    status,
    end_reason: reason,
    total_listens_end: finite(station?.total_listens),
    followers_end: profile?.followers ?? null,
    total_streams_end: profile?.total_streams ?? null,
    raw: station,
  }, now);
  await saveState(env, state.id, {
    phase: 'idle',
    sessionId: null,
    stationId: null,
    candidateCount: 0,
    inactiveCount: 0,
    lastProfileAt: 0,
    lastQueueHash: null,
    lastSuccessAt: now,
    lastError: null,
  });
}

async function collectSoloDetails(env, config, auth, state, station, now) {
  const stationIdentity = identity(station);
  const queue = normalizeQueue(station, now);
  await internalIngest(saveHostIngest, env, 'solo_station_snapshot', {
    session_id: state.sessionId,
    source_scope: 'sakurazaka46jp_solo',
    handle: config.soloHandle,
    account_id: stationIdentity.accountId,
    station_id: stationIdentity.stationId,
    broadcast_id: stationIdentity.broadcastId,
    broadcast_start_time: stationIdentity.broadcastStartTime,
    is_broadcasting: station?.is_broadcasting ?? null,
    status: station?.status ?? null,
    chat_status: station?.chat_status ?? null,
    listener_count: finite(station?.listener_count),
    guest_count: finite(station?.guest_count),
    total_listens: finite(station?.total_listens),
    channel_id: stationIdentity.channelId,
    channel_alias: stationIdentity.channelAlias,
    current_track_id: queue?.current_track_id ?? null,
    current_spotify_id: queue?.current_spotify_id ?? null,
    queue_id: queue?.queue_id ?? null,
    queue_start_time: queue?.start_time ?? null,
    raw: station,
  }, now);

  let lastQueueHash = state.lastQueueHash;
  if (queue) {
    const nextHash = await queueHash(queue);
    if (nextHash !== state.lastQueueHash) {
      await internalIngest(saveHostIngest, env, 'solo_queue', {
        session_id: state.sessionId,
        queue_hash: nextHash,
        ...queue,
      }, now);
      await enrichTracks(env, config, queue, now).catch((error) => {
        console.warn(JSON.stringify({ event: 'cloud_solo_track_metadata_failed', error: String(error?.message || error) }));
      });
      lastQueueHash = nextHash;
    }
  }

  const history = await stationRequest(
    `/station/${encodeURIComponent(stationIdentity.stationId)}/chatHistory?limit=${config.soloChatLimit}`,
    config,
    auth,
  ).catch((error) => {
    console.warn(JSON.stringify({ event: 'cloud_solo_comments_failed', error: String(error?.message || error) }));
    return null;
  });
  const comments = normalizeComments(history, stationIdentity.stationId);
  if (comments.length) {
    await internalIngest(saveHostIngest, env, 'solo_comments', {
      session_id: state.sessionId,
      station_id: stationIdentity.stationId,
      comments,
    }, now);
  }

  const lastProfileAt = await collectSoloProfile(
    env,
    config,
    auth,
    state,
    stationIdentity.accountId || config.soloAccountId,
    now,
  );
  return { lastQueueHash, lastProfileAt };
}

async function probeSolo(env, config, auth, now, recoveredState = null) {
  const state = recoveredState || await recoverSoloState(env, config);
  const [station, buddies] = await Promise.all([
    stationRequest(`/station/handle/${encodeURIComponent(config.soloHandle)}/guest`, config, auth, {
      method: 'POST',
      body: '{}',
    }),
    env.DB.prepare(`SELECT station_id FROM sh_channel_snapshots ORDER BY observed_at DESC LIMIT 1`).first(),
  ]);
  const stationIdentity = identity(station);
  const buddiesStationId = finite(buddies?.station_id);
  const candidate = Boolean(
    station?.is_broadcasting
    && station?.broadcast
    && stationIdentity.stationId
    && buddiesStationId
    && stationIdentity.stationId !== buddiesStationId
  );

  if (!candidate) {
    if (!state.sessionId) {
      await saveState(env, state.id, {
        ...state,
        phase: 'idle',
        candidateCount: 0,
        inactiveCount: 0,
        lastSuccessAt: now,
        lastError: null,
      });
      return;
    }
    if (state.phase === 'provisional') {
      await closeSolo(env, config, auth, state, station, now, 'cancelled', 'provisional_not_confirmed');
      return;
    }
    const inactiveCount = state.inactiveCount + 1;
    if (inactiveCount >= config.soloEndConfirmPolls) {
      await closeSolo(env, config, auth, state, station, now, 'ended', 'not_broadcasting');
      return;
    }
    await saveState(env, state.id, {
      ...state,
      inactiveCount,
      lastSuccessAt: now,
      lastError: null,
    });
    return;
  }

  if (state.sessionId && state.stationId !== stationIdentity.stationId) {
    await closeSolo(env, config, auth, state, station, now, 'ended', 'station_changed');
    state.sessionId = null;
    state.stationId = null;
    state.phase = 'idle';
    state.candidateCount = 0;
    state.inactiveCount = 0;
    state.lastQueueHash = null;
    state.lastProfileAt = 0;
  }

  if (!state.sessionId) {
    const opened = await internalIngest(saveHostIngest, env, 'solo_session_open', {
      source_scope: 'sakurazaka46jp_solo',
      handle: config.soloHandle,
      account_id: stationIdentity.accountId,
      station_id: stationIdentity.stationId,
      broadcast_id: stationIdentity.broadcastId,
      broadcast_stream_id: stationIdentity.broadcastStreamId,
      started_at: stationIdentity.broadcastStartTime || now,
      detection_reason: 'official_announcement_window',
      buddies_station_id: buddiesStationId,
      channel_id: stationIdentity.channelId,
      channel_alias: stationIdentity.channelAlias,
      total_listens_start: finite(station?.total_listens),
      raw: station,
    }, now);
    if (!opened.session_id) throw new Error('cloud solo session open returned no session ID');
    state.sessionId = Number(opened.session_id);
    state.stationId = stationIdentity.stationId;
    state.phase = 'provisional';
    state.candidateCount = 1;
    state.inactiveCount = 0;
  } else {
    state.candidateCount += 1;
    state.inactiveCount = 0;
  }

  const detailState = await collectSoloDetails(env, config, auth, state, station, now);
  state.lastQueueHash = detailState.lastQueueHash;
  state.lastProfileAt = detailState.lastProfileAt;

  if (state.phase === 'provisional' && state.candidateCount >= config.soloConfirmPolls) {
    await internalIngest(saveHostIngest, env, 'solo_session_confirm', {
      session_id: state.sessionId,
      confirmed_at: now,
    }, now);
    state.phase = 'active';
  }

  await saveState(env, state.id, {
    ...state,
    lastSuccessAt: now,
    lastError: null,
  });
}

export async function runCloudHostMonitor(env) {
  if (!env.DB || !env.OTHER_DB) return;
  const config = cfg(env);
  const now = Date.now();
  try {
    const auth = await session(env);
    const soloState = await recoverSoloState(env, config);
    const probeDue = await shouldProbeSolo(env, config, soloState, now);
    const tasks = [collectGeneralProfile(env, config, auth, now)];
    if (probeDue) tasks.push(probeSolo(env, config, auth, now, soloState));
    await Promise.all(tasks);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    console.error(JSON.stringify({ event: 'cloud_host_monitor_failed', error: message }));
    try {
      const state = await recoverSoloState(env, config);
      await saveState(env, state.id, { ...state, lastError: message });
    } catch (stateError) {
      if (!/no such table/i.test(String(stateError?.message || ''))) console.error(stateError);
    }
  }
}
