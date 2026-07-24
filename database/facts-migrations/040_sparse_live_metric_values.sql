-- Store repeated live metric values as NULL while preserving the source-shaped
-- compatibility view expected by Pages and maintenance readers. A NULL metric
-- is resolved from the last non-NULL value for the same channel/source.

DROP VIEW IF EXISTS sh_channel_snapshots;
CREATE VIEW sh_channel_snapshots AS
SELECT f.id,f.observed_at,f.channel_id,NULL AS channel_alias,NULL AS channel_name,
  c.station_id,
  COALESCE(f.is_broadcasting,(
    SELECT previous.is_broadcasting FROM sh_minute_facts previous
    WHERE previous.source_code=f.source_code AND previous.channel_id=f.channel_id
      AND (previous.minute_at<f.minute_at OR (previous.minute_at=f.minute_at AND previous.id<f.id))
      AND previous.is_broadcasting IS NOT NULL
    ORDER BY previous.minute_at DESC,previous.id DESC LIMIT 1
  )) AS is_launched,
  COALESCE(f.is_broadcasting,(
    SELECT previous.is_broadcasting FROM sh_minute_facts previous
    WHERE previous.source_code=f.source_code AND previous.channel_id=f.channel_id
      AND (previous.minute_at<f.minute_at OR (previous.minute_at=f.minute_at AND previous.id<f.id))
      AND previous.is_broadcasting IS NOT NULL
    ORDER BY previous.minute_at DESC,previous.id DESC LIMIT 1
  )) AS is_broadcasting,
  NULL AS chat_status,
  COALESCE(f.listener_count,(
    SELECT previous.listener_count FROM sh_minute_facts previous
    WHERE previous.source_code=f.source_code AND previous.channel_id=f.channel_id
      AND (previous.minute_at<f.minute_at OR (previous.minute_at=f.minute_at AND previous.id<f.id))
      AND previous.listener_count IS NOT NULL
    ORDER BY previous.minute_at DESC,previous.id DESC LIMIT 1
  )) AS listener_count,
  COALESCE(f.online_member_count,(
    SELECT previous.online_member_count FROM sh_minute_facts previous
    WHERE previous.source_code=f.source_code AND previous.channel_id=f.channel_id
      AND (previous.minute_at<f.minute_at OR (previous.minute_at=f.minute_at AND previous.id<f.id))
      AND previous.online_member_count IS NOT NULL
    ORDER BY previous.minute_at DESC,previous.id DESC LIMIT 1
  )) AS online_member_count,
  COALESCE((SELECT d.last_total_member_count FROM sh_total_member_daily d
    WHERE d.channel_id=f.channel_id AND d.day_at=(f.observed_at/86400000)*86400000
    ORDER BY d.last_observed_at DESC,d.host_key LIMIT 1),f.total_member_count) AS total_member_count,
  COALESCE(f.guest_count,(
    SELECT previous.guest_count FROM sh_minute_facts previous
    WHERE previous.source_code=f.source_code AND previous.channel_id=f.channel_id
      AND (previous.minute_at<f.minute_at OR (previous.minute_at=f.minute_at AND previous.id<f.id))
      AND previous.guest_count IS NOT NULL
    ORDER BY previous.minute_at DESC,previous.id DESC LIMIT 1
  )) AS guest_count,
  COALESCE(f.reported_total_listens,(
    SELECT previous.reported_total_listens FROM sh_minute_facts previous
    WHERE previous.source_code=f.source_code AND previous.channel_id=f.channel_id
      AND (previous.minute_at<f.minute_at OR (previous.minute_at=f.minute_at AND previous.id<f.id))
      AND previous.reported_total_listens IS NOT NULL
    ORDER BY previous.minute_at DESC,previous.id DESC LIMIT 1
  )) AS total_listens,
  NULL AS stream_goal,
  COALESCE(f.reported_current_stream_count,(
    SELECT previous.reported_current_stream_count FROM sh_minute_facts previous
    WHERE previous.source_code=f.source_code AND previous.channel_id=f.channel_id
      AND (previous.minute_at<f.minute_at OR (previous.minute_at=f.minute_at AND previous.id<f.id))
      AND previous.reported_current_stream_count IS NOT NULL
    ORDER BY previous.minute_at DESC,previous.id DESC LIMIT 1
  )) AS current_stream_count,
  h.stationhead_account_id AS host_account_id,h.current_handle AS host_handle,
  c.broadcast_start_time,NULL AS raw_json,
  COALESCE(f.comment_count,(
    SELECT previous.comment_count FROM sh_minute_facts previous
    WHERE previous.source_code=f.source_code AND previous.channel_id=f.channel_id
      AND (previous.minute_at<f.minute_at OR (previous.minute_at=f.minute_at AND previous.id<f.id))
      AND previous.comment_count IS NOT NULL
    ORDER BY previous.minute_at DESC,previous.id DESC LIMIT 1
  )) AS comment_velocity,
  NULL AS validated_stream_count
FROM sh_minute_facts f
LEFT JOIN sh_minute_fact_context c ON c.fact_id=f.id
LEFT JOIN sh_hosts h ON h.id=c.host_id;

PRAGMA optimize;
