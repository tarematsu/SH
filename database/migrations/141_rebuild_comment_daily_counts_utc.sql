DELETE FROM sh_comment_daily_counts;

INSERT INTO sh_comment_daily_counts(station_id,day_key,comment_count)
SELECT station_id,
  strftime('%Y-%m-%d',bucket_start/1000,'unixepoch') AS day_key,
  SUM(comment_count) AS comment_count
FROM sh_comment_minute_counts
GROUP BY station_id,day_key;
