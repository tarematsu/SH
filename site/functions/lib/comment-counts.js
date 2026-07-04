import { num } from './api-utils.js';

const MINUTE_MS = 60_000;

function timestampOf(comment, fallback) {
  const milliseconds = num(comment?.chat_time_ms);
  if (milliseconds != null) return milliseconds;
  const seconds = num(comment?.chat_time);
  return seconds != null ? seconds * 1000 : fallback;
}

function dayKey(timestamp) {
  return new Date(timestamp + 9 * 3_600_000).toISOString().slice(0, 10);
}

export async function saveCommentCounts(db, observedAt, data) {
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  const stationId = num(data?.station_id ?? comments.find((item) => num(item?.station_id) != null)?.station_id);
  if (stationId == null || comments.length === 0) {
    return { accepted: 0, total: num(data?.total_count) ?? 0, velocityUpdated: false, skipped: true };
  }

  const state = await db.prepare(`SELECT last_comment_id,total_count,last_observed_at
    FROM sh_comment_state WHERE station_id=?`).bind(stationId).first();
  const lastId = num(state?.last_comment_id) ?? 0;
  const unique = new Map();
  for (const comment of comments) {
    const id = num(comment?.id);
    if (id != null && id > lastId) unique.set(id, comment);
  }
  const fresh = [...unique.entries()].sort((left, right) => left[0] - right[0]);
  const reportedTotal = num(data?.total_count);
  const derivedTotal = (num(state?.total_count) ?? 0) + fresh.length;
  const total = reportedTotal == null ? derivedTotal : Math.max(derivedTotal, reportedTotal);
  if (!fresh.length) return { accepted: 0, total, velocityUpdated: false, skipped: true };

  const minutes = new Map();
  const days = new Map();
  let lastObservedAt = num(state?.last_observed_at) ?? 0;
  for (const [, comment] of fresh) {
    const timestamp = timestampOf(comment, observedAt);
    const minute = Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
    minutes.set(minute, (minutes.get(minute) || 0) + 1);
    const day = dayKey(timestamp);
    days.set(day, (days.get(day) || 0) + 1);
    lastObservedAt = Math.max(lastObservedAt, timestamp);
  }

  const statements = [];
  for (const [minute, count] of minutes) {
    statements.push(db.prepare(`INSERT INTO sh_comment_minute_counts(
        station_id,bucket_start,comment_count
      ) VALUES(?,?,?) ON CONFLICT(station_id,bucket_start) DO UPDATE SET
        comment_count=sh_comment_minute_counts.comment_count+excluded.comment_count`)
      .bind(stationId, minute, count));
  }
  for (const [day, count] of days) {
    statements.push(db.prepare(`INSERT INTO sh_comment_daily_counts(
        station_id,day_key,comment_count
      ) VALUES(?,?,?) ON CONFLICT(station_id,day_key) DO UPDATE SET
        comment_count=sh_comment_daily_counts.comment_count+excluded.comment_count`)
      .bind(stationId, day, count));
  }
  statements.push(db.prepare(`INSERT INTO sh_comment_state(
      station_id,last_comment_id,total_count,last_observed_at
    ) VALUES(?,?,?,?) ON CONFLICT(station_id) DO UPDATE SET
      last_comment_id=MAX(sh_comment_state.last_comment_id,excluded.last_comment_id),
      total_count=MAX(sh_comment_state.total_count,excluded.total_count),
      last_observed_at=MAX(sh_comment_state.last_observed_at,excluded.last_observed_at)`)
    .bind(stationId, fresh.at(-1)[0], total, lastObservedAt));
  await db.batch(statements);

  return {
    accepted: fresh.length,
    total,
    velocity: null,
    velocityUpdated: false,
  };
}
