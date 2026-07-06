CREATE VIEW IF NOT EXISTS sh_legacy_metric_history_utc AS
SELECT id,observed_at,listener_count,total_stream_count AS stream_value,
  total_member_count,host_handle,
  strftime('%Y-%m-%d',observed_at/1000,'unixepoch') AS utc_day,
  strftime('%Y-%m',observed_at/1000,'unixepoch') AS utc_month
FROM sh_legacy_history_rows;
