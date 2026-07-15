import { sanitizeFailureDetail } from './collector-failure.js';
import { enqueueMinuteFactJob } from './minute-facts-inbox.js';
import { minuteBucket, timestampMs } from './minute-facts-store.js';

export const MINUTE_FACT_REBUILD_CRON = '7,17,27,37,47,57 * * * *';
export const REBUILD_STATE_KEY = 'snapshot-minute-facts-v1';

const DEFAULT_SOURCE_ROWS = 20;
const DEFAULT_MAX_JOBS = 4;
const DEFAULT_RECENT_GUARD_MS = 15 * 60_000;
const DEFAULT_MAX_CARRY_MINUTES = 5;
const MAX_PENDING_CANDIDATES = 200;

export const MINUTE_FACT_REBUILD_STATE_SQL = `CREATE TABLE IF NOT EXISTS sh_minute_fact_rebuild_state (
  rebuild_key TEXT PRIMARY KEY,
  cursor_observed_at INTEGER NOT NULL DEFAULT 0,
  cursor_snapshot_id INTEGER NOT NULL DEFAULT 0,
  last_snapshot_json TEXT,
  pending_json TEXT NOT NULL DEFAULT '[]',
  scanned_snapshots INTEGER NOT NULL DEFAULT 0,
  exact_candidates INTEGER NOT NULL DEFAULT 0,
  carried_candidates INTEGER NOT NULL DEFAULT 0,
  enqueued_jobs INTEGER NOT NULL DEFAULT 0,
  skipped_existing INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
)`;

let schemaReady = false;

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = integer(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function compactSnapshotRow(row = {}) {
  return {
    id: integer(row.id),
    observed_at: integer(row.observed_at),
    channel_id: integer(row.channel_id),
    channel_alias: row.channel_alias || null,
    channel_name: row.channel_name || null,
    station_id: integer(row.station_id),
    is_launched: integer(row.is_launched),
    is_broadcasting: integer(row.is_broadcasting),
    chat_status: row.chat_status || null,
    listener_count: integer(row.listener_count),
    online_member_count: integer(row.online_member_count),
    total_member_count: integer(row.total_member_count),
    guest_count: integer(row.guest_count),
    total_listens: integer(row.total_listens),
    stream_goal: integer(row.stream_goal),
    current_stream_count: integer(row.current_stream_count),
    host_account_id: integer(row.host_account_id),
    host_handle: row.host_handle || null,
    broadcast_start_time: integer(row.broadcast_start_time),
  };
}

function snapshotPayload(row) {
  return {
    channel_id: row.channel_id,
    channel_alias: row.channel_alias,
    channel_name: row.channel_name,
    station_id: row.station_id,
    is_launched: row.is_launched,
    is_broadcasting: row.is_broadcasting,
    chat_status: row.chat_status,
    listener_count: row.listener_count,
    online_member_count: row.online_member_count,
    total_member_count: row.total_member_count,
    guest_count: row.guest_count,
    total_listens: row.total_listens,
    stream_goal: row.stream_goal,
    current_stream_count: row.current_stream_count,
    host_account_id: row.host_account_id,
    host_handle: row.host_handle,
    broadcast_start_time: row.broadcast_start_time,
  };
}

function candidateKey(candidate) {
  return `${candidate.snapshot.channel_id}:${candidate.minuteAt}`;
}

function rebuildCandidate(row, minuteAt, mode) {
  const observedAt = mode === 'exact'
    ? integer(row.observed_at)
    : minuteAt + 30_000;
  return {
    minuteAt,
    observedAt,
    snapshot: snapshotPayload(row),
    rebuild: {
      source: 'snapshot_rebuild',
      mode,
      source_snapshot_id: integer(row.id),
      source_observed_at: integer(row.observed_at),
    },
  };
}

export function buildRebuildCandidates(rows = [], previousRow = null, options = {}) {
  const maxCarryMinutes = positiveInteger(
    options.maxCarryMinutes,
    DEFAULT_MAX_CARRY_MINUTES,
    15,
  );
  const candidates = new Map();
  let previous = previousRow ? compactSnapshotRow(previousRow) : null;

  for (const rawRow of rows) {
    const row = compactSnapshotRow(rawRow);
    const currentMinute = minuteBucket(row.observed_at);
    if (previous
        && previous.channel_id === row.channel_id
        && previous.station_id === row.station_id) {
      const previousMinute = minuteBucket(previous.observed_at);
      const gapMinutes = Math.round((currentMinute - previousMinute) / 60_000);
      const sameBroadcast = previous.is_broadcasting === row.is_broadcasting
        && (previous.broadcast_start_time ?? null) === (row.broadcast_start_time ?? null);
      if (sameBroadcast && gapMinutes > 1 && gapMinutes <= maxCarryMinutes) {
        for (let minute = previousMinute + 60_000; minute < currentMinute; minute += 60_000) {
          const candidate = rebuildCandidate(previous, minute, 'carry_forward');
          candidates.set(candidateKey(candidate), candidate);
        }
      }
    }
    const exact = rebuildCandidate(row, currentMinute, 'exact');
    candidates.set(candidateKey(exact), exact);
    previous = row;
  }

  return {
    candidates: [...candidates.values()].sort((a, b) => a.minuteAt - b.minuteAt),
    lastSnapshot: previous,
  };
}

export function retainUncommittedRebuildCandidate(result, candidate, remaining) {
  if (result?.enqueued) return true;
  remaining.push(candidate);
  return false;
}

async function ensureRebuildSchema(env) {
  if (!env?.MINUTE_DB) throw new Error('minute fact rebuild MINUTE_DB binding is missing');
  if (schemaReady) return;
  await env.MINUTE_DB.prepare(MINUTE_FACT_REBUILD_STATE_SQL).run();
  await env.MINUTE_DB.prepare(`INSERT OR IGNORE INTO sh_minute_fact_rebuild_state(
      rebuild_key,updated_at
    ) VALUES(?,?)`).bind(REBUILD_STATE_KEY, Date.now()).run();
  schemaReady = true;
}

async function loadState(env) {
  await ensureRebuildSchema(env);
  return env.MINUTE_DB.prepare('SELECT * FROM sh_minute_fact_rebuild_state WHERE rebuild_key=?')
    .bind(REBUILD_STATE_KEY)
    .first();
}

async function saveState(env, values = {}) {
  const state = await loadState(env);
  await env.MINUTE_DB.prepare(`UPDATE sh_minute_fact_rebuild_state SET
      cursor_observed_at=?,cursor_snapshot_id=?,last_snapshot_json=?,pending_json=?,
      scanned_snapshots=?,exact_candidates=?,carried_candidates=?,enqueued_jobs=?,
      skipped_existing=?,last_error=?,updated_at=?
    WHERE rebuild_key=?`).bind(
    integer(values.cursor_observed_at) ?? integer(state.cursor_observed_at) ?? 0,
    integer(values.cursor_snapshot_id) ?? integer(state.cursor_snapshot_id) ?? 0,
    values.last_snapshot_json === undefined ? state.last_snapshot_json : values.last_snapshot_json,
    values.pending_json === undefined ? state.pending_json : values.pending_json,
    integer(values.scanned_snapshots) ?? integer(state.scanned_snapshots) ?? 0,
    integer(values.exact_candidates) ?? integer(state.exact_candidates) ?? 0,
    integer(values.carried_candidates) ?? integer(state.carried_candidates) ?? 0,
    integer(values.enqueued_jobs) ?? integer(state.enqueued_jobs) ?? 0,
    integer(values.skipped_existing) ?? integer(state.skipped_existing) ?? 0,
    values.last_error === undefined ? state.last_error : values.last_error,
    Date.now(),
    REBUILD_STATE_KEY,
  ).run();
}

async function loadSourceRows(env, state, config, cutoff) {
  return env.DB.prepare(`SELECT id,observed_at,channel_id,channel_alias,channel_name,station_id,
      is_launched,is_broadcasting,chat_status,listener_count,online_member_count,
      total_member_count,guest_count,total_listens,stream_goal,current_stream_count,
      host_account_id,host_handle,broadcast_start_time
    FROM sh_channel_snapshots
    WHERE observed_at<? AND (
      observed_at>? OR (observed_at=? AND id>?)
    )
    ORDER BY observed_at ASC,id ASC LIMIT ?`)
    .bind(
      cutoff,
      integer(state.cursor_observed_at) || 0,
      integer(state.cursor_observed_at) || 0,
      integer(state.cursor_snapshot_id) || 0,
      config.sourceRows,
    )
    .all();
}

async function existingFactKeys(env, candidates) {
  const keys = new Set();
  const byChannel = new Map();
  for (const candidate of candidates) {
    const channelId = integer(candidate.snapshot?.channel_id);
    if (channelId == null) continue;
    if (!byChannel.has(channelId)) byChannel.set(channelId, []);
    byChannel.get(channelId).push(candidate.minuteAt);
  }
  for (const [channelId, minutes] of byChannel) {
    const uniqueMinutes = [...new Set(minutes)];
    for (let index = 0; index < uniqueMinutes.length; index += 70) {
      const part = uniqueMinutes.slice(index, index + 70);
      const placeholders = part.map(() => '?').join(',');
      const result = await env.MINUTE_DB.prepare(`SELECT channel_id,minute_at FROM sh_minute_facts
        WHERE channel_id=? AND minute_at IN (${placeholders})`).bind(channelId, ...part).all();
      for (const row of result.results || []) keys.add(`${row.channel_id}:${row.minute_at}`);
    }
  }
  return keys;
}

async function loadHistoricalQueue(env, candidate) {
  if (Number(candidate.snapshot?.is_broadcasting) === 0 || candidate.snapshot?.station_id == null) return null;
  const row = await env.DB.prepare(`SELECT id,observed_at,station_id,queue_id,start_time,is_paused,raw_json
    FROM sh_queue_snapshots
    WHERE station_id IS ? AND observed_at<=?
    ORDER BY observed_at DESC,id DESC LIMIT 1`)
    .bind(candidate.snapshot.station_id, candidate.observedAt)
    .first();
  if (!row) return null;
  const queue = safeJson(row.raw_json, null);
  if (!queue || !Array.isArray(queue.tracks)) return null;
  const queueStart = timestampMs(queue.start_time ?? row.start_time);
  const broadcastStart = timestampMs(candidate.snapshot.broadcast_start_time);
  if (broadcastStart != null && queueStart != null && queueStart < broadcastStart - 5 * 60_000) return null;
  return {
    ...queue,
    station_id: integer(queue.station_id ?? row.station_id),
    queue_id: integer(queue.queue_id ?? row.queue_id),
    start_time: integer(queue.start_time ?? row.start_time),
    is_paused: integer(queue.is_paused ?? row.is_paused),
  };
}

async function loadHistoricalCommentsBatch(env, candidates) {
  const byKey = new Map();
  const pairs = [...new Map((candidates || [])
    .filter((candidate) => candidate.snapshot?.station_id != null)
    .map((candidate) => [`${candidate.snapshot.station_id}:${candidate.minuteAt}`, candidate]))
    .values()];
  if (!pairs.length) return byKey;
  const stationIds = [...new Set(pairs.map((candidate) => integer(candidate.snapshot.station_id)))];
  const minutes = [...new Set(pairs.map((candidate) => candidate.minuteAt))];
  const stationSql = stationIds.map(() => '?').join(',');
  const minuteSql = minutes.map(() => '?').join(',');
  const result = await env.DB.prepare(`SELECT station_id,bucket_start,comment_count FROM sh_comment_minute_counts
    WHERE station_id IN (${stationSql}) AND bucket_start IN (${minuteSql})`)
    .bind(...stationIds, ...minutes).all();
  for (const row of result.results || []) byKey.set(`${row.station_id}:${row.bucket_start}`, Number(row.comment_count));
  return byKey;
}

function configFromEnv(env = {}) {
  return {
    sourceRows: positiveInteger(env.REBUILD_SOURCE_ROWS, DEFAULT_SOURCE_ROWS, 100),
    maxJobs: positiveInteger(env.REBUILD_MAX_JOBS, DEFAULT_MAX_JOBS, 20),
    recentGuardMs: positiveInteger(env.REBUILD_RECENT_GUARD_MS, DEFAULT_RECENT_GUARD_MS, 24 * 60 * 60_000),
    maxCarryMinutes: positiveInteger(env.REBUILD_MAX_CARRY_MINUTES, DEFAULT_MAX_CARRY_MINUTES, 15),
  };
}

export async function runMinuteFactsBackfill(env, dependencies = {}) {
  if (!env?.DB) throw new Error('minute fact rebuild DB binding is missing');
  if (!env?.MINUTE_DB) throw new Error('minute fact rebuild MINUTE_DB binding is missing');
  const now = dependencies.now ? dependencies.now() : Date.now();
  const config = configFromEnv(env);
  const state = await loadState(env);
  let pending = safeJson(state.pending_json, []);
  let scannedThisRun = 0;
  let exactThisRun = 0;
  let carriedThisRun = 0;

  try {
    if (!pending.length) {
      const result = await loadSourceRows(env, state, config, now - config.recentGuardMs);
      const rows = result.results || [];
      if (rows.length) {
        const previous = safeJson(state.last_snapshot_json, null);
        const built = buildRebuildCandidates(rows, previous, {
          maxCarryMinutes: config.maxCarryMinutes,
        });
        pending = built.candidates.slice(0, MAX_PENDING_CANDIDATES);
        scannedThisRun = rows.length;
        exactThisRun = pending.filter((candidate) => candidate.rebuild.mode === 'exact').length;
        carriedThisRun = pending.filter((candidate) => candidate.rebuild.mode === 'carry_forward').length;
        const lastRow = compactSnapshotRow(rows.at(-1));
        await saveState(env, {
          cursor_observed_at: lastRow.observed_at,
          cursor_snapshot_id: lastRow.id,
          last_snapshot_json: JSON.stringify(built.lastSnapshot),
          pending_json: JSON.stringify(pending),
          scanned_snapshots: Number(state.scanned_snapshots || 0) + scannedThisRun,
          exact_candidates: Number(state.exact_candidates || 0) + exactThisRun,
          carried_candidates: Number(state.carried_candidates || 0) + carriedThisRun,
          last_error: null,
        });
      }
    }

    const existing = await existingFactKeys(env, pending);
    const commentsByKey = await loadHistoricalCommentsBatch(env, pending);
    let enqueued = 0;
    let skippedExisting = 0;
    const remaining = [];
    for (const candidate of pending) {
      if (existing.has(candidateKey(candidate))) {
        skippedExisting += 1;
        continue;
      }
      if (enqueued >= config.maxJobs) {
        remaining.push(candidate);
        continue;
      }
      const queue = await loadHistoricalQueue(env, candidate);
      const commentKey = `${candidate.snapshot?.station_id}:${candidate.minuteAt}`;
      const commentCount = commentsByKey.get(commentKey);
      const comments = candidate.snapshot?.station_id == null
        ? { commentCount: null, commentTotal: null, degraded: true }
        : { commentCount: commentCount ?? null, commentTotal: null, degraded: commentCount == null };
      const mode = candidate.rebuild.mode;
      const result = await enqueueMinuteFactJob(env, {
        observedAt: candidate.observedAt,
        snapshot: candidate.snapshot,
        queue,
        comments,
        rebuild: candidate.rebuild,
      }, {
        jobKind: 'rebuild',
        jobPriority: mode === 'exact' ? 20 : 10,
        requeueCompleted: true,
      });
      if (retainUncommittedRebuildCandidate(result, candidate, remaining)) enqueued += 1;
    }

    const latestState = await loadState(env);
    await saveState(env, {
      pending_json: JSON.stringify(remaining),
      enqueued_jobs: Number(latestState.enqueued_jobs || 0) + enqueued,
      skipped_existing: Number(latestState.skipped_existing || 0) + skippedExisting,
      last_error: null,
    });

    const summary = {
      event: 'minute_fact_rebuild_summary',
      scanned_snapshots: scannedThisRun,
      exact_candidates: exactThisRun,
      carried_candidates: carriedThisRun,
      enqueued,
      skipped_existing: skippedExisting,
      pending_candidates: remaining.length,
      cursor_observed_at: Number(latestState.cursor_observed_at || 0),
    };
    console.log(JSON.stringify(summary));
    return summary;
  } catch (error) {
    await saveState(env, { last_error: sanitizeFailureDetail(error?.message || error) }).catch(() => {});
    throw error;
  }
}

export function resetMinuteFactRebuildForTests() {
  schemaReady = false;
}
