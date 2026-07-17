import { normalizeBuddyQueuePayload } from './buddy-fetch-guard.js';
import { recordBuddyFailure, recordBuddySuccess } from './buddy-health.js';
import {
  BUDDY_PLAYBACK_CLOCK_UPSERT_SQL,
  BUDDY_PLAYBACK_SELECT_SQL,
  BUDDY_PLAYBACK_TOUCH_SQL,
  BUDDY_PLAYBACK_UPSERT_SQL,
  buddyPlaybackClock,
  buddyPlaybackConfig,
  shouldRunBuddyPlayback,
} from './buddy-playback.js';
import { attachBuddyMetadata, enrichQueueMetadata } from './buddy-playback-metadata.js';
import { extractBuddyPlayback, validateBuddyChannelPayload } from './buddy-playback-queue.js';
import { collectBuddyPlaybackReady } from './buddy-runtime.js';
import { sanitizeFailureDetail } from './collector-failure.js';

const API_BASE = 'https://production1.stationhead.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const PIPELINE_LEASE_MS = 90_000;
const PIPELINE_RETRY_MS = 5 * 60_000;
const PIPELINE_MAX_AGE_MS = 2 * 60 * 60_000;
const BENIGN_SKIP_REASONS = new Set(['not-due', 'pipeline-busy', 'retry-not-due']);

export const BUDDY_PLAYBACK_PIPELINE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sh_buddy_playback_pipeline (
  channel_alias TEXT PRIMARY KEY,
  cycle_at INTEGER NOT NULL,
  observed_at INTEGER,
  stage TEXT NOT NULL,
  raw_json TEXT,
  parsed_queue_json TEXT,
  state_json TEXT,
  final_queue_json TEXT,
  station_id INTEGER,
  queue_id INTEGER,
  start_time INTEGER,
  is_paused INTEGER,
  is_broadcasting INTEGER,
  host_account_id INTEGER,
  host_handle TEXT,
  track_count INTEGER NOT NULL DEFAULT 0,
  metadata_attempts INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
)`;
const PIPELINE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_sh_buddy_playback_pipeline_due
  ON sh_buddy_playback_pipeline(next_attempt_at, lease_until, updated_at)`;

const PIPELINE_SELECT_COLUMNS = `channel_alias,cycle_at,observed_at,stage,raw_json,
  parsed_queue_json,state_json,final_queue_json,station_id,queue_id,start_time,
  is_paused,is_broadcasting,host_account_id,host_handle,track_count,metadata_attempts,attempts,
  next_attempt_at,lease_until,last_error,updated_at`;
const PIPELINE_SELECT_SQL = `SELECT ${PIPELINE_SELECT_COLUMNS}
  FROM sh_buddy_playback_pipeline WHERE channel_alias=?`;
const PIPELINE_INSERT_SQL = `INSERT OR IGNORE INTO sh_buddy_playback_pipeline (
    channel_alias,cycle_at,stage,updated_at
  ) VALUES (?,?,'fetch',?)`;
const PIPELINE_RESET_STALE_SQL = `UPDATE sh_buddy_playback_pipeline SET
    cycle_at=?,observed_at=NULL,stage='fetch',raw_json=NULL,parsed_queue_json=NULL,
    state_json=NULL,final_queue_json=NULL,station_id=NULL,queue_id=NULL,start_time=NULL,
    is_paused=NULL,is_broadcasting=NULL,host_account_id=NULL,host_handle=NULL,
    track_count=0,metadata_attempts=0,attempts=0,next_attempt_at=0,lease_until=0,last_error=NULL,updated_at=?
  WHERE channel_alias=? AND updated_at<? AND lease_until<=?`;
const PIPELINE_CLAIM_SQL = `UPDATE sh_buddy_playback_pipeline SET
    lease_until=?,attempts=attempts+1,updated_at=?
  WHERE channel_alias=? AND lease_until<=? AND next_attempt_at<=?
  RETURNING ${PIPELINE_SELECT_COLUMNS}`;
const PIPELINE_FETCHED_SQL = `UPDATE sh_buddy_playback_pipeline SET
    observed_at=?,stage='parse',raw_json=?,next_attempt_at=0,lease_until=0,
    last_error=NULL,updated_at=?
  WHERE channel_alias=? AND cycle_at=? AND stage='fetch'`;
const PIPELINE_PARSED_SQL = `UPDATE sh_buddy_playback_pipeline SET
    stage='metadata',raw_json=NULL,parsed_queue_json=?,state_json=?,
    final_queue_json=NULL,station_id=?,queue_id=?,start_time=?,is_paused=?,
    is_broadcasting=?,host_account_id=?,host_handle=?,track_count=?,metadata_attempts=0,
    next_attempt_at=0,lease_until=0,last_error=NULL,updated_at=?
  WHERE channel_alias=? AND cycle_at=? AND stage='parse'`;
const PIPELINE_METADATA_SQL = `UPDATE sh_buddy_playback_pipeline SET
    stage=?,final_queue_json=?,metadata_attempts=metadata_attempts+?,next_attempt_at=0,
    lease_until=CASE WHEN ?='commit' THEN lease_until ELSE 0 END,last_error=NULL,updated_at=?
  WHERE channel_alias=? AND cycle_at=? AND stage='metadata'`;
const PIPELINE_FAILURE_SQL = `UPDATE sh_buddy_playback_pipeline SET
    next_attempt_at=?,lease_until=0,last_error=?,updated_at=?
  WHERE channel_alias=? AND cycle_at=? AND stage=?`;
const PIPELINE_DELETE_SQL = `DELETE FROM sh_buddy_playback_pipeline
  WHERE channel_alias=? AND cycle_at=? AND stage='commit'`;

let pipelineFlightsByContext = new WeakMap();
let pipelineSchemaReady = false;

function finiteNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function booleanValue(value) {
  return value === true || value === 1 || String(value || '').trim().toLowerCase() === 'true';
}

function requestContextKey(ctx) {
  return ctx && (typeof ctx === 'object' || typeof ctx === 'function') ? ctx : null;
}

function safeNow(now) {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
}

function releasePipelineFlight(ctx, flight) {
  const key = requestContextKey(ctx);
  if (key && pipelineFlightsByContext.get(key) === flight) pipelineFlightsByContext.delete(key);
}

function healthWriteError(event, error) {
  console.error(JSON.stringify({
    event,
    error: sanitizeFailureDetail(error?.message || error),
  }));
}

function pipelineTableMissing(error) {
  return /no such table:\s*sh_buddy_playback_pipeline/i.test(String(error?.message || error));
}

async function ensurePipelineSchema(env) {
  if (pipelineSchemaReady) return false;
  await env.OTHER_DB.batch([
    env.OTHER_DB.prepare(BUDDY_PLAYBACK_PIPELINE_SCHEMA_SQL),
    env.OTHER_DB.prepare(PIPELINE_INDEX_SQL),
  ]);
  pipelineSchemaReady = true;
  return true;
}

function playbackTableMissing(error) {
  return /no such table:\s*sh_playback_channel_current/i.test(String(error?.message || error));
}

function changedRows(result) {
  return Number(result?.meta?.changes || 0);
}

function requireChanged(result, stage) {
  if (changedRows(result) <= 0) throw new Error(`buddy46 pipeline ${stage} stage lost its durable claim`);
}

function cycleStart(scheduledAt, intervalMs) {
  return Math.floor(scheduledAt / intervalMs) * intervalMs;
}

function pipelineMetadataAttemptLimit(env) {
  const value = Math.trunc(Number(env?.BUDDY_PLAYBACK_PIPELINE_METADATA_ATTEMPTS ?? 5));
  return Number.isFinite(value) ? Math.max(0, Math.min(20, value)) : 5;
}

function displayStateChanged(current, state) {
  if (!current) return true;
  return booleanValue(current.is_broadcasting) !== state.is_broadcasting
    || finiteNumber(current.host_account_id) !== state.host_account_id
    || (String(current.host_handle || '').trim() || null) !== state.host_handle;
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

function sessionFromEnv(env) {
  const state = env?.__buddyAuthState || {};
  const authToken = state.authToken || env?.BUDDY_PLAYBACK_AUTH_TOKEN || env?.BUDDY46_AUTH_TOKEN;
  const deviceUid = state.deviceUid || env?.BUDDY_PLAYBACK_DEVICE_UID || env?.BUDDY46_DEVICE_UID;
  if (!authToken || !deviceUid) throw new Error('buddy46 session is missing for staged playback collection');
  return { authToken, deviceUid };
}

function stationHeaders(session, config) {
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

export function buddyPlaybackPipelineSlot(scheduledAt) {
  const absoluteMinute = Math.floor(Number(scheduledAt) / 60_000);
  if (!Number.isFinite(absoluteMinute)) return false;
  const slot = ((absoluteMinute % 30) + 30) % 30;
  return slot === 0 || slot === 5 || slot === 15;
}

export async function fetchBuddyPlaybackText(env, config, request = fetch) {
  const session = sessionFromEnv(env);
  const response = await request(`${API_BASE}/station/handle/${encodeURIComponent(config.alias)}/guest`, {
    method: 'POST',
    headers: stationHeaders(session, config),
    body: '',
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Stationhead buddy staged playback API ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.text();
}

export async function buddyPlaybackStateHash(stateJson) {
  const bytes = new TextEncoder().encode(String(stateJson));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let result = '';
  for (const value of new Uint8Array(digest)) result += value.toString(16).padStart(2, '0');
  return result;
}

export function parseBuddyPlaybackPipelinePayload(rawJson, config) {
  const normalized = normalizeBuddyQueuePayload(JSON.parse(rawJson), config.alias);
  validateBuddyChannelPayload(normalized, config.alias);
  const queue = extractBuddyPlayback(normalized, config.alias, config.maxTracks);
  const playbackState = {
    station_id: queue.station_id,
    queue_id: queue.queue_id,
    start_time: queue.start_time,
    is_paused: queue.is_paused,
    tracks: queue.tracks,
  };
  return {
    queue,
    parsedQueueJson: JSON.stringify(queue),
    stateJson: JSON.stringify(playbackState),
  };
}

async function preparePipelineJob(env, config, scheduledAt, observedAt) {
  const db = env.OTHER_DB;
  const cycleAt = cycleStart(scheduledAt, config.intervalMs);
  await db.prepare(PIPELINE_RESET_STALE_SQL)
    .bind(cycleAt, observedAt, config.alias, observedAt - PIPELINE_MAX_AGE_MS, observedAt)
    .run();

  let row = await db.prepare(PIPELINE_SELECT_SQL).bind(config.alias).first();
  if (!row && shouldRunBuddyPlayback(scheduledAt, config.intervalMs)) {
    await db.prepare(PIPELINE_INSERT_SQL).bind(config.alias, cycleAt, observedAt).run();
    row = await db.prepare(PIPELINE_SELECT_SQL).bind(config.alias).first();
  }
  if (!row) return { skipped: true, reason: 'not-due' };
  if (finiteNumber(row.next_attempt_at, 0) > observedAt) {
    return { skipped: true, reason: 'retry-not-due', stage: row.stage, cycle_at: row.cycle_at };
  }

  const claimed = await db.prepare(PIPELINE_CLAIM_SQL)
    .bind(observedAt + PIPELINE_LEASE_MS, observedAt, config.alias, observedAt, observedAt)
    .first();
  return claimed || { skipped: true, reason: 'pipeline-busy', stage: row.stage, cycle_at: row.cycle_at };
}

async function runFetchStage(env, row, observedAt, dependencies) {
  const ready = dependencies.collectReady || collectBuddyPlaybackReady;
  const fetchText = dependencies.fetchText || fetchBuddyPlaybackText;
  return ready(env, observedAt, {
    ...dependencies,
    collect: async (runtimeEnv, stageObservedAt, runtimeDependencies = {}) => {
      const config = buddyPlaybackConfig(runtimeEnv);
      const rawJson = await fetchText(runtimeEnv, config, runtimeDependencies.fetch);
      const result = await env.OTHER_DB.prepare(PIPELINE_FETCHED_SQL)
        .bind(stageObservedAt, rawJson, stageObservedAt, row.channel_alias, row.cycle_at)
        .run();
      requireChanged(result, 'fetch');
      return {
        skipped: false,
        pending: true,
        stage: 'parse',
        cycle_at: row.cycle_at,
        checked_at: stageObservedAt,
      };
    },
  });
}

async function runParseStage(env, row, observedAt) {
  const config = buddyPlaybackConfig(env);
  const parsed = parseBuddyPlaybackPipelinePayload(row.raw_json, config);
  const queue = parsed.queue;
  const result = await env.OTHER_DB.prepare(PIPELINE_PARSED_SQL).bind(
    parsed.parsedQueueJson,
    parsed.stateJson,
    queue.station_id,
    queue.queue_id,
    queue.start_time,
    queue.is_paused ? 1 : 0,
    queue.is_broadcasting ? 1 : 0,
    queue.host_account_id,
    queue.host_handle,
    queue.tracks.length,
    observedAt,
    row.channel_alias,
    row.cycle_at,
  ).run();
  requireChanged(result, 'parse');
  return {
    skipped: false,
    pending: true,
    stage: 'metadata',
    cycle_at: row.cycle_at,
    tracks: queue.tracks.length,
    checked_at: row.observed_at,
  };
}

async function runMetadataStage(env, row, observedAt, dependencies) {
  const config = buddyPlaybackConfig(env);
  const totalLimit = pipelineMetadataAttemptLimit(env);
  const alreadyAttempted = Math.max(0, Math.trunc(Number(row.metadata_attempts || 0)));
  const queue = JSON.parse(row.parsed_queue_json);
  const enrich = dependencies.enrichMetadata || enrichQueueMetadata;
  const enriched = await enrich(
    env,
    queue,
    observedAt,
    {
      ...config,
      metadataLimit: alreadyAttempted < totalLimit ? Math.min(1, config.metadataLimit) : 0,
      returnDetails: true,
    },
    dependencies.fetchTrackMetadata,
  );
  const metadata = enriched?.metadata instanceof Map
    ? enriched.metadata
    : enriched instanceof Map ? enriched : new Map();
  const remaining = Math.max(0, Math.trunc(Number(enriched?.remaining || 0)));
  const attempted = Math.max(0, Math.trunc(Number(enriched?.attempted || 0)));
  const processed = alreadyAttempted + attempted;
  const tracks = attachBuddyMetadata(queue, metadata);
  const finalQueueJson = JSON.stringify(tracks);
  const nextStage = remaining > 0 && processed < totalLimit ? 'metadata' : 'commit';
  const result = await env.OTHER_DB.prepare(PIPELINE_METADATA_SQL)
    .bind(nextStage, finalQueueJson, attempted, nextStage, observedAt, row.channel_alias, row.cycle_at)
    .run();
  requireChanged(result, 'metadata');
  if (nextStage === 'commit') {
    row.stage = 'commit';
    row.final_queue_json = finalQueueJson;
    row.metadata_attempts = processed;
    return runCommitStage(env, row, observedAt, dependencies);
  }
  return {
    skipped: false,
    pending: true,
    stage: nextStage,
    cycle_at: row.cycle_at,
    tracks: tracks.length,
    metadata_remaining: remaining,
    checked_at: row.observed_at,
  };
}

async function runCommitStage(env, row, observedAt, dependencies) {
  if (!row.state_json || !row.final_queue_json) {
    throw new Error('buddy46 pipeline commit is missing parsed state');
  }
  const current = await env.OTHER_DB.prepare(BUDDY_PLAYBACK_SELECT_SQL)
    .bind(row.channel_alias)
    .first();
  const hash = await (dependencies.stateHash || buddyPlaybackStateHash)(row.state_json);
  const state = {
    station_id: finiteNumber(row.station_id),
    queue_id: finiteNumber(row.queue_id),
    start_time: finiteNumber(row.start_time),
    is_paused: booleanValue(row.is_paused),
    is_broadcasting: booleanValue(row.is_broadcasting),
    host_account_id: finiteNumber(row.host_account_id),
    host_handle: String(row.host_handle || '').trim() || null,
  };
  const playbackChanged = current?.state_hash !== hash;
  const contentChanged = current?.queue_json !== row.final_queue_json;
  const displayChanged = displayStateChanged(current, state);
  const changed = playbackChanged || contentChanged || displayChanged;
  const checkedAt = finiteNumber(row.observed_at, observedAt);
  const clock = buddyPlaybackClock(current, state, checkedAt);
  const playbackStatement = changed
    ? env.OTHER_DB.prepare(BUDDY_PLAYBACK_UPSERT_SQL).bind(
      row.channel_alias,
      state.station_id,
      state.queue_id,
      state.start_time,
      state.is_paused ? 1 : 0,
      state.is_broadcasting ? 1 : 0,
      state.host_account_id,
      state.host_handle,
      hash,
      row.final_queue_json,
      checkedAt,
      playbackChanged ? checkedAt : finiteNumber(current?.changed_at, checkedAt),
    )
    : env.OTHER_DB.prepare(BUDDY_PLAYBACK_TOUCH_SQL).bind(checkedAt, row.channel_alias);

  await env.OTHER_DB.batch([
    playbackStatement,
    clockStatement(env.OTHER_DB, row.channel_alias, clock),
    env.OTHER_DB.prepare(PIPELINE_DELETE_SQL).bind(row.channel_alias, row.cycle_at),
  ]);
  return {
    skipped: false,
    channel_alias: row.channel_alias,
    changed,
    playback_changed: playbackChanged,
    content_changed: contentChanged,
    display_changed: displayChanged,
    tracks: Math.max(0, Math.trunc(Number(row.track_count || 0))),
    checked_at: checkedAt,
    paused_total_ms: clock.paused_total_ms,
    pipeline_completed: true,
  };
}

async function failPipelineStage(env, row, error, observedAt) {
  const detail = sanitizeFailureDetail(error?.message || error);
  await env.OTHER_DB.prepare(PIPELINE_FAILURE_SQL)
    .bind(
      observedAt + PIPELINE_RETRY_MS,
      detail,
      observedAt,
      row.channel_alias,
      row.cycle_at,
      row.stage,
    )
    .run();
}

export async function advanceBuddyPlaybackPipeline(
  env,
  scheduledAt,
  observedAt = Date.now(),
  dependencies = {},
) {
  if (!env?.OTHER_DB?.prepare) return { skipped: true, reason: 'db-binding-missing' };
  const config = buddyPlaybackConfig(env);
  if (!config.enabled) return { skipped: true, reason: 'disabled' };
  if (!buddyPlaybackPipelineSlot(scheduledAt)) return { skipped: true, reason: 'not-due' };

  let row;
  try {
    row = await preparePipelineJob(env, config, scheduledAt, observedAt);
  } catch (error) {
    if (!pipelineTableMissing(error)) throw error;
    await ensurePipelineSchema(env);
    row = await preparePipelineJob(env, config, scheduledAt, observedAt);
  }
  if (row?.skipped) return row;

  try {
    if (row.stage === 'fetch') return await runFetchStage(env, row, observedAt, dependencies);
    if (row.stage === 'parse') return await runParseStage(env, row, observedAt);
    if (row.stage === 'metadata') return await runMetadataStage(env, row, observedAt, dependencies);
    if (row.stage === 'commit') return await runCommitStage(env, row, observedAt, dependencies);
    throw new Error(`unsupported buddy46 pipeline stage: ${row.stage}`);
  } catch (error) {
    await failPipelineStage(env, row, error, observedAt).catch(() => {});
    if (playbackTableMissing(error)) return { skipped: true, reason: 'playback-table-setup-required' };
    throw error;
  }
}

export function scheduleBuddyPlaybackPipeline(
  env,
  ctx,
  scheduledAt = Date.now(),
  dependencies = {},
  now = Date.now,
) {
  const initialConfig = buddyPlaybackConfig(env);
  if (!initialConfig.enabled) return Promise.resolve({ skipped: true, reason: 'disabled' });
  if (!buddyPlaybackPipelineSlot(scheduledAt)) return Promise.resolve({ skipped: true, reason: 'not-due' });

  const key = requestContextKey(ctx);
  const existing = key ? pipelineFlightsByContext.get(key) : null;
  if (existing) {
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(existing);
    return existing;
  }

  const observedAt = safeNow(now);
  const task = Promise.resolve().then(async () => {
    const config = buddyPlaybackConfig(env);
    try {
      const result = await advanceBuddyPlaybackPipeline(env, scheduledAt, observedAt, dependencies);
      if (result?.pending || BENIGN_SKIP_REASONS.has(String(result?.reason || ''))) return result;
      if (result?.skipped) {
        const reason = String(result.reason || 'unknown');
        await recordBuddyFailure(env, config.alias, new Error(`Buddy playback skipped: ${reason}`), observedAt)
          .catch((error) => healthWriteError('buddy_playback_pipeline_health_skip_write_failed', error));
        return result;
      }
      await recordBuddySuccess(env, config.alias, result, observedAt)
        .catch((error) => healthWriteError('buddy_playback_pipeline_health_success_write_failed', error));
      return result;
    } catch (error) {
      await recordBuddyFailure(env, config.alias, error, observedAt)
        .catch((healthError) => healthWriteError('buddy_playback_pipeline_health_failure_write_failed', healthError));
      console.error(JSON.stringify({
        event: 'buddy_playback_pipeline_failed',
        error: sanitizeFailureDetail(error?.message || error),
      }));
      return { skipped: true, reason: 'collection-failed' };
    }
  });
  const wrappedTask = task.finally(() => releasePipelineFlight(ctx, wrappedTask));
  if (key) pipelineFlightsByContext.set(key, wrappedTask);
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(wrappedTask);
  return wrappedTask;
}

export function resetBuddyPlaybackPipelineFlightForTests() {
  pipelineFlightsByContext = new WeakMap();
  pipelineSchemaReady = false;
}
