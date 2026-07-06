INSERT OR REPLACE INTO sh_daily_summary(
  period_key,period_start,period_end,sample_count,reliable_sample_count,
  listener_avg,listener_min,listener_max,stream_start,stream_end,stream_growth,
  member_start,member_end,member_growth,likes_max,distinct_tracks,primary_host,
  quality_score,quality_flags,updated_at
)
SELECT d.period_key,d.period_start,d.period_end,d.sample_count,d.reliable_sample_count,
  d.listener_avg,d.listener_min,d.listener_max,d.stream_start,d.stream_end,
  CASE WHEN d.stream_start IS NOT NULL AND d.stream_end>=d.stream_start
    THEN d.stream_end-d.stream_start END,
  d.member_start,d.member_end,
  CASE WHEN d.member_start IS NOT NULL AND d.member_end IS NOT NULL
    THEN d.member_end-d.member_start END,
  NULL,NULL,
  (SELECT host_handle FROM sh_metric_history_utc_all h
    WHERE h.utc_day=d.period_key AND h.host_handle IS NOT NULL AND trim(h.host_handle)<>''
    GROUP BY host_handle ORDER BY COUNT(*) DESC,host_handle ASC LIMIT 1),
  1,'["utc_rebuild"]',unixepoch('now')*1000
FROM sh_daily_metric_utc d
WHERE d.sample_count>0;
