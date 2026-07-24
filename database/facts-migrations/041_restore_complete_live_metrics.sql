-- Revert migration 040's carry-forward view. Live minute facts once again store
-- complete metric values, so readers must use the value on the selected row and
-- avoid correlated lookbacks across the accumulated minute-fact history.

DROP VIEW IF EXISTS sh_channel_snapshots;
CREATE VIEW sh_channel_snapshots AS
SELECT f.id,f.observed_at,f.channel_id,NULL AS channel_alias,NULL AS channel_name,
  c.station_id,f.is_broadcasting AS is_launched,f.is_broadcasting,
  NULL AS chat_status,f.listener_count,f.online_member_count,
  COALESCE((SELECT d.last_total_member_count FROM sh_total_member_daily d
    WHERE d.channel_id=f.channel_id AND d.day_at=(f.observed_at/86400000)*86400000
    ORDER BY d.last_observed_at DESC,d.host_key LIMIT 1),f.total_member_count) AS total_member_count,
  f.guest_count,f.reported_total_listens AS total_listens,NULL AS stream_goal,
  f.reported_current_stream_count AS current_stream_count,
  h.stationhead_account_id AS host_account_id,h.current_handle AS host_handle,
  c.broadcast_start_time,NULL AS raw_json,f.comment_count AS comment_velocity,
  NULL AS validated_stream_count
FROM sh_minute_facts f
LEFT JOIN sh_minute_fact_context c ON c.fact_id=f.id
LEFT JOIN sh_hosts h ON h.id=c.host_id;
