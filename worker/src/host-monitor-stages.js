import { hourBucket, claimWrite } from '../../site/functions/lib/ingest-claim.js';
import { num, rawJson, text } from '../../site/functions/lib/api-utils.js';
import { runCloudHostMonitor } from './cloud-host-monitor.js';
import { finite, normalizeProfile } from './cloud-host-monitor-normalize.js';

const API_BASE = 'https://production1.stationhead.com';
const COLLECTOR_ID = 'cloudflare-worker';
const SOURCE_PRIORITY = 100;
const JSON_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json' });
const DELAYED_QUEUE_SEND_OPTIONS = Object.freeze({ contentType: 'json', delaySeconds: 1 });
const PROFILE_INTERVAL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

function positive(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(number, maximum);
}

function profileConfig(env) {
  return {
    handle: env?.HOST_PROFILE_HANDLE || 'sakuramankai',
    accountId: finite(env?.HOST_PROFILE_ACCOUNT_ID) || 3334889,
    intervalMs: positive(env?.HOST_PROFILE_INTERVAL_MS, PROFILE_INTERVAL_MS),
    requestTimeoutMs: positive(env?.REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS, 30_000),
    appVersion: env?.STATIONHEAD_APP_VERSION || env?.SH_APP_VERSION || '1.0.0',
  };
}

function profileStateId(config) {
  return `profile:${config.handle}`;
}

function soloStateId(env) {
  return `solo:${env?.SOLO_BROADCAST_HANDLE || 'sakurazaka46jp'}`;
}

function requestHeaders(config, auth) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    authorization: `Bearer ${auth.auth_token}`,
    'app-platform': 'web',
    'app-version': config.appVersion,
    'content-type': 'application/json',
    origin: 'https://www.stationhead.com',
    referer: 'https://www.stationhead.com/',
    'sth-device-uid': auth.device_uid,
  };
}

async function defaultPlan(env, now) {
  if (!env?.OTHER_DB?.prepare) return { profileDue: false, soloDue: false };
  const config = profileConfig(env);
  const profileId = profileStateId(config);
  const soloId = soloStateId(env);
  const early = positive(env?.OFFICIAL_NEWS_EARLY_WINDOW_MS, 10 * 60_000);
  const late = positive(env?.OFFICIAL_NEWS_LATE_WINDOW_MS, 90 * 60_000);
  let row;
  try {
    row = await env.OTHER_DB.prepare(`SELECT
      COALESCE((SELECT last_profile_at FROM sh_cloud_host_monitor_state WHERE id=?),0) AS profile_last_at,
      COALESCE((SELECT session_id FROM sh_cloud_host_monitor_state WHERE id=?),0) AS solo_session_id,
      COALESCE((SELECT phase FROM sh_cloud_host_monitor_state WHERE id=?),'idle') AS solo_phase,
      EXISTS(SELECT 1 FROM sh_official_news_announcements
        WHERE scheduled_at IS NOT NULL AND (
          (status='scheduled' AND scheduled_at>=? AND scheduled_at<=?) OR status='active'
        ) LIMIT 1) AS official_due`).bind(
      profileId,
      soloId,
      soloId,
      now - late,
      now + early,
    ).first();
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error;
    row = await env.OTHER_DB.prepare(`SELECT
      COALESCE((SELECT last_profile_at FROM sh_cloud_host_monitor_state WHERE id=?),0) AS profile_last_at,
      COALESCE((SELECT session_id FROM sh_cloud_host_monitor_state WHERE id=?),0) AS solo_session_id,
      COALESCE((SELECT phase FROM sh_cloud_host_monitor_state WHERE id=?),'idle') AS solo_phase`).bind(
      profileId,
      soloId,
      soloId,
    ).first().catch(() => null);
  }
  const lastProfileAt = Number(row?.profile_last_at || 0);
  const soloPhase = String(row?.solo_phase || 'idle');
  return {
    profileDue: !lastProfileAt || now - lastProfileAt >= config.intervalMs,
    soloDue: Number(row?.solo_session_id || 0) > 0
      || soloPhase === 'provisional'
      || soloPhase === 'active'
      || Boolean(row?.official_due),
  };
}

function stageMessage(task, stage, details = null) {
  return {
    message_type: 'host-monitor-task',
    message_version: 1,
    scheduled_at: task.scheduledAt,
    observed_at: task.observedAt,
    host_stage: stage,
    ...(details || {}),
  };
}

async function sendStage(env, task, stage, details = null, delayed = false, dependencies = {}) {
  const body = stageMessage(task, stage, details);
  if (dependencies.send) return dependencies.send(body, delayed);
  if (!env?.HOST_MONITOR_QUEUE?.send) throw new Error('HOST_MONITOR_QUEUE binding is missing');
  return env.HOST_MONITOR_QUEUE.send(
    body,
    delayed ? DELAYED_QUEUE_SEND_OPTIONS : JSON_QUEUE_SEND_OPTIONS,
  );
}

async function fetchProfile(env, observedAt, request = fetch) {
  const config = profileConfig(env);
  const [auth, channel] = await Promise.all([
    env.OTHER_DB.prepare(`SELECT auth_token,device_uid
      FROM sh_worker_collector_state WHERE id='buddy46'`).first(),
    env.MINUTE_DB.prepare(`SELECT channel_id FROM sh_minute_facts
      ORDER BY minute_at DESC,id DESC LIMIT 1`).first(),
  ]);
  if (!auth?.auth_token || !auth?.device_uid) throw new Error('Stationhead cloud session unavailable');
  const channelId = finite(channel?.channel_id) || 318;
  const response = await request(
    `${API_BASE}/account?ids=${encodeURIComponent(config.accountId)}&channelId=${encodeURIComponent(channelId)}`,
    {
      headers: requestHeaders(config, auth),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    },
  );
  if (!response.ok) throw new Error(`Stationhead profile ${response.status}`);
  const payload = await response.json();
  const profile = normalizeProfile(payload?.accounts?.[0], config.handle);
  if (!profile?.handle) throw new Error(`profile unavailable for @${config.handle}`);
  return { profile, observedAt };
}

async function persistProfile(env, profile, observedAt) {
  if (!env?.OTHER_DB?.prepare) throw new Error('OTHER_DB binding is missing');
  const scope = text(profile?.source_scope) || 'profile_monitor';
  const handle = text(profile?.handle) || 'unknown';
  const sessionId = num(profile?.session_id);
  const bucket = sessionId
    ? Math.floor(observedAt / 60_000) * 60_000
    : hourBucket(observedAt);
  const dedupeKey = sessionId
    ? `profile:${scope}:${handle}:session:${sessionId}:minute:${bucket}`
    : `profile:${scope}:${handle}:hour:${bucket}`;
  const claim = await claimWrite(env.OTHER_DB, {
    dedupeKey,
    dataType: 'host_profile_snapshot',
    collectorId: COLLECTOR_ID,
    collectorKind: 'cloud',
    sourcePriority: SOURCE_PRIORITY,
    observedAt,
    payload: {
      account_id: num(profile?.account_id),
      followers: num(profile?.followers),
      following: num(profile?.following),
      total_streams: num(profile?.total_streams),
      active_stream_days: num(profile?.active_stream_days),
    },
  });
  if (claim.accepted) {
    await env.OTHER_DB.prepare(`INSERT INTO sh_host_profile_snapshots (
      observed_at,source_scope,session_id,handle,account_id,
      followers,following,total_streams,active_stream_days,emoji,
      thumbnail_url,medium_url,main_url,badges_json,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      observedAt,
      scope,
      sessionId,
      handle,
      num(profile?.account_id),
      num(profile?.followers),
      num(profile?.following),
      num(profile?.total_streams),
      num(profile?.active_stream_days),
      text(profile?.emoji),
      text(profile?.thumbnail_url),
      text(profile?.medium_url),
      text(profile?.main_url),
      rawJson(profile?.badges),
      rawJson(profile?.raw),
    ).run();
    if (sessionId) {
      await env.OTHER_DB.prepare(`UPDATE sh_host_broadcast_sessions SET
        account_id=COALESCE(account_id,?),followers_start=COALESCE(followers_start,?),
        total_streams_start=COALESCE(total_streams_start,?) WHERE id=?`).bind(
        num(profile?.account_id),
        num(profile?.followers),
        num(profile?.total_streams),
        sessionId,
      ).run();
    }
  }
  const config = profileConfig(env);
  await env.OTHER_DB.prepare(`INSERT INTO sh_cloud_host_monitor_state (
    id,session_id,station_id,phase,candidate_count,inactive_count,
    last_profile_at,last_queue_hash,last_success_at,last_error,updated_at
  ) VALUES (?,NULL,NULL,'idle',0,0,?,NULL,?,NULL,?)
  ON CONFLICT(id) DO UPDATE SET
    last_profile_at=excluded.last_profile_at,last_success_at=excluded.last_success_at,
    last_error=NULL,updated_at=excluded.updated_at`).bind(
    profileStateId(config),
    observedAt,
    observedAt,
    Date.now(),
  ).run();
  return { accepted: claim.accepted, duplicate: claim.duplicate === true };
}

function soloOnlyEnv(env) {
  const active = Object.create(env || null);
  Object.defineProperty(active, 'HOST_PROFILE_INTERVAL_MS', {
    value: Number.MAX_SAFE_INTEGER,
    enumerable: false,
  });
  return active;
}

async function runPlan(env, task, dependencies) {
  const load = dependencies.loadPlan || defaultPlan;
  const plan = await load(env, task.observedAt);
  let dispatched = 0;
  if (plan?.profileDue) {
    await sendStage(env, task, 'profile-fetch', null, false, dependencies);
    dispatched += 1;
  }
  if (plan?.soloDue) {
    await sendStage(env, task, 'solo-run', null, dispatched > 0, dependencies);
    dispatched += 1;
  }
  return {
    stage: 'plan',
    profile_due: plan?.profileDue === true,
    solo_due: plan?.soloDue === true,
    dispatched,
  };
}

async function runProfileFetch(env, task, dependencies) {
  const load = dependencies.fetchProfile || fetchProfile;
  const prepared = await load(env, task.observedAt, dependencies.fetch);
  await sendStage(env, task, 'profile-persist', {
    profile: prepared.profile,
  }, true, dependencies);
  return { stage: 'profile-fetch', pending: true, handle: prepared.profile?.handle };
}

async function runProfilePersist(env, task, dependencies) {
  if (!task.profile || typeof task.profile !== 'object') {
    throw new Error('host profile persist payload is missing');
  }
  const save = dependencies.persistProfile || persistProfile;
  const result = await save(env, task.profile, task.observedAt);
  return { stage: 'profile-persist', pending: false, ...result };
}

async function runSolo(env, dependencies) {
  const run = dependencies.runSolo || runCloudHostMonitor;
  await run(soloOnlyEnv(env));
  return { stage: 'solo-run', pending: false };
}

export async function processHostMonitorStage(env, task, dependencies = {}) {
  switch (task.stage) {
    case 'profile-fetch': return runProfileFetch(env, task, dependencies);
    case 'profile-persist': return runProfilePersist(env, task, dependencies);
    case 'solo-run': return runSolo(env, dependencies);
    default: return runPlan(env, task, dependencies);
  }
}
