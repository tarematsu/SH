CREATE TRIGGER IF NOT EXISTS trg_sh_comments_count_only
BEFORE INSERT ON sh_comments
BEGIN
  INSERT INTO sh_comment_minute_counts(station_id,bucket_start,comment_count)
  SELECT NEW.station_id,
         CAST(COALESCE(NEW.chat_time_ms,NEW.chat_time*1000,NEW.observed_at)/60000 AS INTEGER)*60000,
         1
  WHERE NEW.station_id IS NOT NULL
    AND NEW.id>COALESCE((SELECT last_comment_id FROM sh_comment_state WHERE station_id=NEW.station_id),0)
  ON CONFLICT(station_id,bucket_start) DO UPDATE SET comment_count=comment_count+1;

  INSERT INTO sh_comment_daily_counts(station_id,day_key,comment_count)
  SELECT NEW.station_id,
         date(COALESCE(NEW.chat_time_ms,NEW.chat_time*1000,NEW.observed_at)/1000,'unixepoch','+9 hours'),
         1
  WHERE NEW.station_id IS NOT NULL
    AND NEW.id>COALESCE((SELECT last_comment_id FROM sh_comment_state WHERE station_id=NEW.station_id),0)
  ON CONFLICT(station_id,day_key) DO UPDATE SET comment_count=comment_count+1;

  INSERT INTO sh_comment_state(station_id,last_comment_id,total_count,last_observed_at)
  SELECT NEW.station_id,NEW.id,1,NEW.observed_at
  WHERE NEW.station_id IS NOT NULL
    AND NEW.id>COALESCE((SELECT last_comment_id FROM sh_comment_state WHERE station_id=NEW.station_id),0)
  ON CONFLICT(station_id) DO UPDATE SET
    last_comment_id=MAX(last_comment_id,excluded.last_comment_id),
    total_count=total_count+1,
    last_observed_at=MAX(last_observed_at,excluded.last_observed_at);

  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS trg_sh_channel_comment_velocity
AFTER UPDATE OF comment_velocity ON sh_channel_snapshots
BEGIN
  UPDATE sh_channel_snapshots
  SET comment_velocity=COALESCE((
    SELECT SUM(comment_count) FROM sh_comment_minute_counts
    WHERE station_id=NEW.station_id
      AND bucket_start>=NEW.observed_at-120000
      AND bucket_start<=NEW.observed_at
  ),0)
  WHERE id=NEW.id;
END;
