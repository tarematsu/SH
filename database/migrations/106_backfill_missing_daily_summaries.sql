WITH RECURSIVE dates(period_key,period_start,period_end) AS (
  SELECT '2026-06-26',
    unixepoch('2026-06-25 15:00:00')*1000,
    unixepoch('2026-06-26 15:00:00')*1000
  UNION ALL
  SELECT date(period_key,'+1 day'),period_start+86400000,period_end+86400000
  FROM dates WHERE period_key<'2026-07-03'
), source_rows AS (
  SELECT id,observed_at,listener_count,
    COALESCE(validated_stream_count,current_stream_count,total_listens) AS stream_value,
    total_member_count,host_handle,0 AS source_priority
  FROM sh_channel_snapshots
  WHERE observed_at>=unixepoch('2026-06-25 15:00:00')*1000
    AND observed_at<unixepoch('2026-07-03 15:00:00')*1000+86400000
  UNION ALL
  SELECT id,observed_at,listener_count,total_stream_count AS stream_value,
    total_member_count,host_handle,1 AS source_priority
  FROM sh_legacy_history_rows
  WHERE observed_at>=unixepoch('2026-06-25 15:00:00')*1000
    AND observed_at<unixepoch('2026-07-03 15:00:00')*1000+86400000
), deduped AS (
  SELECT id,observed_at,listener_count,stream_value,total_member_count,host_handle
  FROM (
    SELECT source_rows.*,
      ROW_NUMBER() OVER (
        PARTITION BY observed_at
        ORDER BY source_priority ASC,id DESC
      ) AS source_rank
    FROM source_rows
  )
  WHERE source_rank=1
), prepared AS (
  SELECT dates.period_key,dates.period_start AS expected_start,
    dates.period_end AS expected_end,deduped.*
  FROM dates
  JOIN deduped
    ON deduped.observed_at>=dates.period_start
   AND deduped.observed_at<dates.period_end
), ranked AS (
  SELECT prepared.*,
    ROW_NUMBER() OVER (
      PARTITION BY period_key
      ORDER BY (stream_value IS NULL) ASC,observed_at ASC,id ASC
    ) AS stream_first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY period_key
      ORDER BY (stream_value IS NULL) ASC,observed_at DESC,id DESC
    ) AS stream_last_rank,
    ROW_NUMBER() OVER (
      PARTITION BY period_key
      ORDER BY (total_member_count IS NULL) ASC,observed_at ASC,id ASC
    ) AS member_first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY period_key
      ORDER BY (total_member_count IS NULL) ASC,observed_at DESC,id DESC
    ) AS member_last_rank
  FROM prepared
), aggregated AS (
  SELECT period_key,MIN(observed_at) AS period_start,MAX(observed_at) AS period_end,
    COUNT(*) AS sample_count,COUNT(listener_count) AS reliable_sample_count,
    AVG(listener_count) AS listener_avg,MIN(listener_count) AS listener_min,
    MAX(listener_count) AS listener_max,
    MAX(CASE WHEN stream_first_rank=1 THEN stream_value END) AS stream_start,
    MAX(CASE WHEN stream_last_rank=1 THEN stream_value END) AS stream_end,
    MAX(CASE WHEN member_first_rank=1 THEN total_member_count END) AS member_start,
    MAX(CASE WHEN member_last_rank=1 THEN total_member_count END) AS member_end
  FROM ranked
  GROUP BY period_key
), host_counts AS (
  SELECT period_key,host_handle,COUNT(*) AS host_samples
  FROM prepared
  WHERE host_handle IS NOT NULL AND trim(host_handle)<>''
  GROUP BY period_key,host_handle
), primary_hosts AS (
  SELECT period_key,host_handle
  FROM (
    SELECT period_key,host_handle,
      ROW_NUMBER() OVER (
        PARTITION BY period_key
        ORDER BY host_samples DESC,host_handle ASC
      ) AS host_rank
    FROM host_counts
  )
  WHERE host_rank=1
)
INSERT INTO sh_daily_summary(
  period_key,period_start,period_end,sample_count,reliable_sample_count,
  listener_avg,listener_min,listener_max,stream_start,stream_end,stream_growth,
  member_start,member_end,member_growth,likes_max,distinct_tracks,primary_host,
  quality_score,quality_flags,updated_at
)
SELECT aggregated.period_key,aggregated.period_start,aggregated.period_end,
  aggregated.sample_count,aggregated.reliable_sample_count,
  aggregated.listener_avg,aggregated.listener_min,aggregated.listener_max,
  aggregated.stream_start,aggregated.stream_end,
  CASE
    WHEN aggregated.stream_start IS NOT NULL
      AND aggregated.stream_end IS NOT NULL
      AND aggregated.stream_end>=aggregated.stream_start
    THEN aggregated.stream_end-aggregated.stream_start
  END,
  aggregated.member_start,aggregated.member_end,
  CASE
    WHEN aggregated.member_start IS NOT NULL AND aggregated.member_end IS NOT NULL
    THEN aggregated.member_end-aggregated.member_start
  END,
  NULL,NULL,primary_hosts.host_handle,1,
  '["historical_gap_backfill"]',unixepoch('now')*1000
FROM aggregated
LEFT JOIN primary_hosts ON primary_hosts.period_key=aggregated.period_key
WHERE aggregated.sample_count>0
ON CONFLICT(period_key) DO UPDATE SET
  period_start=excluded.period_start,
  period_end=excluded.period_end,
  sample_count=excluded.sample_count,
  reliable_sample_count=excluded.reliable_sample_count,
  listener_avg=excluded.listener_avg,
  listener_min=excluded.listener_min,
  listener_max=excluded.listener_max,
  stream_start=excluded.stream_start,
  stream_end=excluded.stream_end,
  stream_growth=excluded.stream_growth,
  member_start=excluded.member_start,
  member_end=excluded.member_end,
  member_growth=excluded.member_growth,
  primary_host=excluded.primary_host,
  quality_score=excluded.quality_score,
  quality_flags=excluded.quality_flags,
  updated_at=excluded.updated_at;
