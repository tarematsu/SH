const WINDOW_MS = 120000;

export const COMMENT_VELOCITY_UPDATE_SQL = `UPDATE sh_channel_snapshots
SET comment_velocity=COALESCE((
  SELECT SUM(comment_count) FROM sh_comment_minute_counts
  WHERE station_id=? AND bucket_start>=? AND bucket_start<=?
),0)
WHERE id=(
  SELECT id FROM sh_channel_snapshots
  WHERE station_id=? AND observed_at<=?
  ORDER BY observed_at DESC,id DESC LIMIT 1
)
AND COALESCE(comment_velocity,-1)<>COALESCE((
  SELECT SUM(comment_count) FROM sh_comment_minute_counts
  WHERE station_id=? AND bucket_start>=? AND bucket_start<=?
),0)`;

export function commentVelocityStatement(db, stationId, observedAt) {
  const start = observedAt - WINDOW_MS;
  return db.prepare(COMMENT_VELOCITY_UPDATE_SQL).bind(
    stationId, start, observedAt,
    stationId, observedAt,
    stationId, start, observedAt,
  );
}

export async function refreshCommentVelocity(db, stationId, observedAt) {
  const result = await commentVelocityStatement(db, stationId, observedAt).run();
  return Number(result?.meta?.changes || 0) > 0;
}
