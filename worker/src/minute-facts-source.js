import { minuteBucket } from './minute-facts-store.js';

function integer(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export async function loadMinuteCommentFacts(db, stationId, observedAt) {
  const normalizedStationId = integer(stationId);
  if (!db || normalizedStationId == null) return { commentCount: null, commentTotal: null };
  try {
    const [minute, state] = await Promise.all([
      db.prepare(`SELECT comment_count FROM sh_comment_minute_counts
        WHERE station_id=? AND bucket_start=?`)
        .bind(normalizedStationId, minuteBucket(observedAt)).first(),
      db.prepare('SELECT total_count FROM sh_comment_state WHERE station_id=?')
        .bind(normalizedStationId).first(),
    ]);
    return {
      commentCount: integer(minute?.comment_count) ?? 0,
      commentTotal: integer(state?.total_count),
    };
  } catch {
    return { commentCount: null, commentTotal: null };
  }
}
