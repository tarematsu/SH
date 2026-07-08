import { num } from './api-utils.js';
import {
  prepared,
  runPreparedD1Batches,
  unwrapPreparedStatement,
} from './d1-batch.js';
import { MINUTE_MS, minuteBucket, utcDayKey } from './time-buckets.js';

const VELOCITY_WINDOW_MS = 2 * MINUTE_MS;
export const D1_COMMENT_BATCH_VARIABLE_LIMIT = 90;
const runtimeCursors = new WeakMap();

export const COMMENT_VELOCITY_UPDATE_SQL = `UPDATE sh_channel_snapshots
SET comment_velocity=COALESCE((
  SELECT SUM(comment_count)
  FROM sh_comment_minute_counts
  WHERE station_id=? AND bucket_start>=? AND bucket_start<=?
),0)
WHERE id=(
  SELECT id FROM sh_channel_snapshots
  WHERE station_id=? AND observed_at<=?
  ORDER BY observed_at DESC,id DESC LIMIT 1
)
AND COALESCE(comment_velocity,-1)<>COALESCE((
  SELECT SUM(comment_count)
  FROM sh_comment_minute_counts
  WHERE station_id=? AND bucket_start>=? AND bucket_start<=?
),0)`;

async function runPreparedBatches(db, statements) {
  return runPreparedD1Batches(db, statements, {
    variableLimit: D1_COMMENT_BATCH_VARIABLE_LIMIT,
  });
}

function timestampOf(comment, fallback) {
  const milliseconds = num(comment?.chat_time_ms);
  if (milliseconds != null) return milliseconds;
  const seconds = num(comment?.chat_time);
  return seconds != null ? seconds * 1000 : fallback;
}

function commentId(comment) {
  return num(comment?.comment_id ?? comment?.id);
}

function uniqueComments(comments) {
  const unique = new Map();
  for (const comment of comments) {
    const id = commentId(comment);
    if (id != null) unique.set(id, comment);
  }
  return [...unique.entries()].sort((left, right) => left[0] - right[0]);
}

function cursorMap(db) {
  let cursors = runtimeCursors.get(db);
  if (!cursors) {
    cursors = new Map();
    runtimeCursors.set(db, cursors);
  }
  return cursors;
}

function commentVelocityPreparedStatement(db, stationId, observedAt) {
  const windowStart = observedAt - VELOCITY_WINDOW_MS;
  return prepared(db.prepare(COMMENT_VELOCITY_UPDATE_SQL).bind(
    stationId,
    windowStart,
    observedAt,
    stationId,
    observedAt,
    stationId,
    windowStart,
    observedAt,
  ), 8);
}

async function refreshCommentVelocity(db, stationId, observedAt) {
  const result = await unwrapPreparedStatement(commentVelocityPreparedStatement(db, stationId, observedAt)).run();
  return Number(result?.meta?.changes || 0) > 0;
}

export function resetCommentCountRuntimeState(db) {
  if (db) runtimeCursors.delete(db);
}

export async function saveCommentCounts(db, observedAt, data) {
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  const stationId = num(data?.station_id ?? comments.find((item) => num(item?.station_id) != null)?.station_id);
  const knownLastId = num(data?.known_last_comment_id);
  const reportedTotal = num(data?.total_count);
  const ordered = uniqueComments(comments);
  const newestIncomingId = ordered.at(-1)?.[0] ?? null;
  if (stationId == null) {
    return {
      accepted: 0,
      total: reportedTotal ?? 0,
      last_comment_id: knownLastId,
      velocityUpdated: false,
      skipped: true,
    };
  }
  if (ordered.length === 0) {
    const velocityUpdated = await refreshCommentVelocity(db, stationId, observedAt);
    return {
      accepted: 0,
      total: reportedTotal ?? 0,
      last_comment_id: knownLastId,
      velocityUpdated,
      skipped: true,
    };
  }

  const cursors = cursorMap(db);
  const cachedLastId = num(cursors.get(stationId));
  if (knownLastId != null && newestIncomingId != null && newestIncomingId <= knownLastId) {
    cursors.set(stationId, Math.max(cachedLastId ?? 0, knownLastId));
    return {
      accepted: 0,
      total: reportedTotal ?? 0,
      last_comment_id: knownLastId,
      velocityUpdated: false,
      skipped: true,
      cursorHit: true,
    };
  }
  const trustedLastId = Math.max(knownLastId ?? 0, cachedLastId ?? 0);
  if (newestIncomingId != null && trustedLastId > 0 && newestIncomingId <= trustedLastId) {
    const velocityUpdated = await refreshCommentVelocity(db, stationId, observedAt);
    return {
      accepted: 0,
      total: reportedTotal ?? 0,
      last_comment_id: trustedLastId,
      velocityUpdated,
      skipped: true,
      cursorHit: true,
    };
  }

  const state = await db.prepare(`SELECT last_comment_id,total_count,last_observed_at
    FROM sh_comment_state WHERE station_id=?`).bind(stationId).first();
  const lastId = num(state?.last_comment_id) ?? 0;
  cursors.set(stationId, Math.max(cachedLastId ?? 0, lastId));
  const fresh = ordered.filter(([id]) => id > lastId);
  const derivedTotal = (num(state?.total_count) ?? 0) + fresh.length;
  const total = reportedTotal == null ? derivedTotal : Math.max(derivedTotal, reportedTotal);
  if (!fresh.length) {
    const velocityUpdated = await refreshCommentVelocity(db, stationId, observedAt);
    return {
      accepted: 0,
      total,
      last_comment_id: lastId || knownLastId,
      velocityUpdated,
      skipped: true,
    };
  }

  const minutes = new Map();
  const days = new Map();
  let lastObservedAt = num(state?.last_observed_at) ?? 0;
  for (const [, comment] of fresh) {
    const timestamp = timestampOf(comment, observedAt);
    const minute = minuteBucket(timestamp);
    minutes.set(minute, (minutes.get(minute) || 0) + 1);
    const day = utcDayKey(timestamp);
    days.set(day, (days.get(day) || 0) + 1);
    lastObservedAt = Math.max(lastObservedAt, timestamp);
  }

  const statements = [];
  for (const [minute, count] of minutes) {
    statements.push(prepared(db.prepare(`INSERT INTO sh_comment_minute_counts(
        station_id,bucket_start,comment_count
      ) VALUES(?,?,?) ON CONFLICT(station_id,bucket_start) DO UPDATE SET
        comment_count=sh_comment_minute_counts.comment_count+excluded.comment_count`)
      .bind(stationId, minute, count), 3));
  }
  for (const [day, count] of days) {
    statements.push(prepared(db.prepare(`INSERT INTO sh_comment_daily_counts(
        station_id,day_key,comment_count
      ) VALUES(?,?,?) ON CONFLICT(station_id,day_key) DO UPDATE SET
        comment_count=sh_comment_daily_counts.comment_count+excluded.comment_count`)
      .bind(stationId, day, count), 3));
  }
  const newestAcceptedId = fresh.at(-1)[0];
  statements.push(prepared(db.prepare(`INSERT INTO sh_comment_state(
      station_id,last_comment_id,total_count,last_observed_at
    ) VALUES(?,?,?,?) ON CONFLICT(station_id) DO UPDATE SET
      last_comment_id=MAX(sh_comment_state.last_comment_id,excluded.last_comment_id),
      total_count=MAX(sh_comment_state.total_count,excluded.total_count),
      last_observed_at=MAX(sh_comment_state.last_observed_at,excluded.last_observed_at)`)
    .bind(stationId, newestAcceptedId, total, lastObservedAt), 4));
  statements.push(commentVelocityPreparedStatement(db, stationId, observedAt));
  const results = await runPreparedBatches(db, statements);
  const velocityResult = results.at(-1);
  const velocityUpdated = Number(velocityResult?.meta?.changes || 0) > 0;
  cursors.set(stationId, newestAcceptedId);

  return {
    accepted: fresh.length,
    total,
    last_comment_id: newestAcceptedId,
    velocity: null,
    velocityUpdated,
  };
}
