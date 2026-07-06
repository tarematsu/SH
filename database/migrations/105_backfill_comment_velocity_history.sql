UPDATE sh_channel_snapshots
SET comment_velocity=COALESCE((
  SELECT SUM(counts.comment_count)
  FROM sh_comment_minute_counts AS counts
  WHERE counts.station_id=sh_channel_snapshots.station_id
    AND counts.bucket_start>=sh_channel_snapshots.observed_at-120000
    AND counts.bucket_start<=sh_channel_snapshots.observed_at
),0)
WHERE observed_at>=unixepoch('now','-24 hours')*1000
  AND COALESCE(comment_velocity,-1)<>COALESCE((
    SELECT SUM(counts.comment_count)
    FROM sh_comment_minute_counts AS counts
    WHERE counts.station_id=sh_channel_snapshots.station_id
      AND counts.bucket_start>=sh_channel_snapshots.observed_at-120000
      AND counts.bucket_start<=sh_channel_snapshots.observed_at
  ),0);
