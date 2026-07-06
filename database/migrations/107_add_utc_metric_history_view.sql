CREATE VIEW IF NOT EXISTS sh_metric_history_utc AS
SELECT id,observed_at,listener_count,
  COALESCE(validated_stream_count,current_stream_count,total_listens) AS stream_value,
  total_member_count,host_handle,
  strftime('%Y-%m-%d',observed_at/1000,'unixepoch') AS utc_day
FROM sh_channel_snapshots;
