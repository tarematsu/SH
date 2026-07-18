import { sanitizeFailureDetail } from './collector-failure.js';
import {
  buildRebuildCandidates,
  MINUTE_FACT_REBUILD_STATE_SQL,
  REBUILD_STATE_KEY,
} from './minute-facts-backfill.js';
import { enqueueMinuteFactJob } from './minute-facts-inbox.js';
import { timestampMs } from './minute-facts-store.js';

const DEFAULT_SOURCE_ROWS = 20;
const DEFAULT_RECENT_GUARD_MS = 15 * 60_000;
const DEFAULT_MAX_CARRY_MINUTES = 5;
const MAX_PENDING_CANDIDATES = 200;

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

function candidateKey(candidate) {
  return `${integer(candidate?.snapshot?.channel_id)}:${integer(candidate?.minuteAt)}`;
}

function configFromEnv(env = {}) {
  return {
    sourceRows: positiveInteger(env.REBUILD_SOURCE_ROWS, DEFAULT_SOURCE_ROWS, 100),
    recentGuardMs: positiveInteger(
      env.REBUILD_RECENT_GUARD_MS,
      DEFAULT_RECENT_GUARD_MS,
      24 * 60 * 60_000,
    ),
    maxCarryMinutes: positiveInteger(
      env.REBUILD_MAX_CARRY_MINUTES,
      DEFAULT_MAX_CARRY_MINUTES,
      15,
    ),
  };
}

async function installState(env) {
  await env.MINUTE_DB.prepare(MINUTE_FACT_REBUILD_STATE_SQL).run();
  await env.MINUTE_DB.prepare(`INSERT OR IGNORE INTO sh_minute_fact_rebuild_state(
      rebuild_key,updated_at
    ) VALUES(?,?)`).bind(REBUILD_STATE_KEY, Date.now()).run();
}

async function loadState(env) {
  try {
    return await env.MINUTE_DB.prepare(
      'SELECT * FROM sh_minute_fact_rebuild_state WHERE rebuild_key=?',
    ).bind(REBUILD_STATE_KEY).first();
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error;
    await installState(env);
    return env.MINUTE_DB.prepare(
      'SELECT * FROM sh_minute_fact_rebuild_state WHERE rebuild_key=?',
    ).bind(REBUILD_STATE_KEY).first();
  }
}

async function updateState(env, state, values = {}) {
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

async function saveError(env, error) {
  try {
    const state = await loadState(env);
    await updateState(env, state, {
      last_error: sanitizeFailureDetail(error?.message || error),
    });
  } catch {}
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

async function factExists(env, candidate) {
  const row = await env.MINUTE_DB.prepare(`SELECT 1 AS present FROM sh_minute_facts
    WHERE channel_id=? AND minute_at=? LIMIT 1`)
    .bind(integer(candidate.snapshot?.channel_id), integer(candidate.minuteAt))
    .first();
  return Boolean(row);
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

async function loadHistoricalComment(env, candidate) {
  const stationId = integer(candidate.snapshot?.station_id);
  if (stationId == null) return null;
  const row = await env.DB.prepare(`SELECT comment_count FROM sh_comment_minute_counts
    WHERE station_id=? AND bucket_start=? LIMIT 1`)
    .bind(stationId, integer(candidate.minuteAt))
    .first();
  return row?.comment_count == null ? null : Number(row.comment_count);
}

function commentsFor(candidate, count) {
  if (candidate.snapshot?.station_id == null) {
    return { commentCount: null, commentTotal: null, degraded: true };
  }
  return {
    commentCount: count ?? null,
    commentTotal: null,
    degraded: count == null,
  };
}

function summary(state, values = {}) {
  return {
    event: 'minute_fact_rebuild_summary',
    scanned_snapshots: Number(values.scanned_snapshots || 0),
    exact_candidates: Number(values.exact_candidates || 0),
    carried_candidates: Number(values.carried_candidates || 0),
    enqueued: Number(values.enqueued || 0),
    skipped_existing: Number(values.skipped_existing || 0),
    pending_candidates: Number(values.pending_candidates || 0),
    cursor_observed_at: Number(values.cursor_observed_at ?? state?.cursor_observed_at ?? 0),
  };
}

export async function scanMinuteFactsBackfill(env, dependencies = {}) {
  if (!env?.DB || !env?.MINUTE_DB) throw new Error('minute fact rebuild database binding is missing');
  try {
    const now = dependencies.now ? dependencies.now() : Date.now();
    const config = configFromEnv(env);
    const state = await loadState(env);
    const pending = safeJson(state.pending_json, []);
    if (pending.length) return summary(state, { pending_candidates: pending.length });

    const source = await loadSourceRows(env, state, config, now - config.recentGuardMs);
    const rows = source.results || [];
    if (!rows.length) return summary(state);
    const previous = safeJson(state.last_snapshot_json, null);
    const built = buildRebuildCandidates(rows, previous, {
      maxCarryMinutes: config.maxCarryMinutes,
    });
    const candidates = built.candidates.slice(0, MAX_PENDING_CANDIDATES);
    const exact = candidates.filter((candidate) => candidate.rebuild.mode === 'exact').length;
    const carried = candidates.length - exact;
    const lastRow = compactSnapshotRow(rows.at(-1));
    await updateState(env, state, {
      cursor_observed_at: lastRow.observed_at,
      cursor_snapshot_id: lastRow.id,
      last_snapshot_json: JSON.stringify(built.lastSnapshot),
      pending_json: JSON.stringify(candidates),
      scanned_snapshots: Number(state.scanned_snapshots || 0) + rows.length,
      exact_candidates: Number(state.exact_candidates || 0) + exact,
      carried_candidates: Number(state.carried_candidates || 0) + carried,
      last_error: null,
    });
    return summary(state, {
      scanned_snapshots: rows.length,
      exact_candidates: exact,
      carried_candidates: carried,
      pending_candidates: candidates.length,
      cursor_observed_at: lastRow.observed_at,
    });
  } catch (error) {
    await saveError(env, error);
    throw error;
  }
}

export async function prepareMinuteFactsBackfillCandidate(env) {
  if (!env?.DB || !env?.MINUTE_DB) throw new Error('minute fact rebuild database binding is missing');
  try {
    const state = await loadState(env);
    const pending = safeJson(state.pending_json, []);
    const candidate = pending[0] || null;
    if (!candidate) return { prepared: null, pending_candidates: 0 };
    if (await factExists(env, candidate)) {
      return {
        prepared: { candidate, skip_existing: true, queue: null, comments: null },
        pending_candidates: pending.length,
      };
    }
    const [queue, commentCount] = await Promise.all([
      loadHistoricalQueue(env, candidate),
      loadHistoricalComment(env, candidate),
    ]);
    return {
      prepared: {
        candidate,
        skip_existing: false,
        queue,
        comments: commentsFor(candidate, commentCount),
      },
      pending_candidates: pending.length,
    };
  } catch (error) {
    await saveError(env, error);
    throw error;
  }
}

export async function commitMinuteFactsBackfillCandidate(env, prepared, dependencies = {}) {
  if (!env?.MINUTE_DB) throw new Error('minute fact rebuild MINUTE_DB binding is missing');
  const candidate = prepared?.candidate;
  if (!candidate?.snapshot) throw new Error('minute fact rebuild candidate is missing');
  try {
    const state = await loadState(env);
    const pending = safeJson(state.pending_json, []);
    const key = candidateKey(candidate);
    const index = pending.findIndex((item) => candidateKey(item) === key);
    if (index < 0) {
      return summary(state, { pending_candidates: pending.length, stale_candidate: true });
    }

    let enqueued = 0;
    let skippedExisting = 0;
    let remove = false;
    if (prepared.skip_existing === true) {
      skippedExisting = 1;
      remove = true;
    } else {
      const enqueue = dependencies.enqueueMinuteFactJob || enqueueMinuteFactJob;
      const mode = candidate.rebuild?.mode;
      const result = await enqueue(env, {
        observedAt: candidate.observedAt,
        snapshot: candidate.snapshot,
        queue: prepared.queue ?? null,
        comments: prepared.comments || commentsFor(candidate, null),
        rebuild: candidate.rebuild,
      }, {
        jobKind: 'rebuild',
        jobPriority: mode === 'exact' ? 20 : 10,
        requeueCompleted: true,
      });
      if (result?.enqueued) {
        enqueued = 1;
        remove = true;
      }
    }

    const remaining = remove
      ? pending.filter((_item, pendingIndex) => pendingIndex !== index)
      : pending;
    if (remove) {
      await updateState(env, state, {
        pending_json: JSON.stringify(remaining),
        enqueued_jobs: Number(state.enqueued_jobs || 0) + enqueued,
        skipped_existing: Number(state.skipped_existing || 0) + skippedExisting,
        last_error: null,
      });
    }
    return summary(state, {
      enqueued,
      skipped_existing: skippedExisting,
      pending_candidates: remaining.length,
    });
  } catch (error) {
    await saveError(env, error);
    throw error;
  }
}
