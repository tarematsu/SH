CREATE VIEW IF NOT EXISTS sh_metric_history_utc_all AS
WITH combined AS (
  SELECT id,observed_at,listener_count,stream_value,total_member_count,host_handle,
    utc_day,utc_month,0 AS source_priority
  FROM sh_metric_history_utc
  UNION ALL
  SELECT id,observed_at,listener_count,stream_value,total_member_count,host_handle,
    utc_day,utc_month,1 AS source_priority
  FROM sh_legacy_metric_history_utc
), ranked AS (
  SELECT combined.*,
    ROW_NUMBER() OVER (
      PARTITION BY observed_at
      ORDER BY source_priority ASC,id DESC
    ) AS source_rank
  FROM combined
)
SELECT id,observed_at,listener_count,stream_value,total_member_count,host_handle,
  utc_day,utc_month
FROM ranked
WHERE source_rank=1;
