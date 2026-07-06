CREATE VIEW IF NOT EXISTS sh_daily_metric_utc AS
WITH ranked AS (
  SELECT sh_metric_history_utc_all.*,
    ROW_NUMBER() OVER (
      PARTITION BY utc_day
      ORDER BY (stream_value IS NULL) ASC,observed_at ASC,id ASC
    ) AS stream_first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY utc_day
      ORDER BY (stream_value IS NULL) ASC,observed_at DESC,id DESC
    ) AS stream_last_rank,
    ROW_NUMBER() OVER (
      PARTITION BY utc_day
      ORDER BY (total_member_count IS NULL) ASC,observed_at ASC,id ASC
    ) AS member_first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY utc_day
      ORDER BY (total_member_count IS NULL) ASC,observed_at DESC,id DESC
    ) AS member_last_rank
  FROM sh_metric_history_utc_all
)
SELECT utc_day AS period_key,
  MIN(observed_at) AS period_start,
  MAX(observed_at) AS period_end,
  COUNT(*) AS sample_count,
  COUNT(listener_count) AS reliable_sample_count,
  AVG(listener_count) AS listener_avg,
  MIN(listener_count) AS listener_min,
  MAX(listener_count) AS listener_max,
  MAX(CASE WHEN stream_first_rank=1 THEN stream_value END) AS stream_start,
  MAX(CASE WHEN stream_last_rank=1 THEN stream_value END) AS stream_end,
  MAX(CASE WHEN member_first_rank=1 THEN total_member_count END) AS member_start,
  MAX(CASE WHEN member_last_rank=1 THEN total_member_count END) AS member_end
FROM ranked
GROUP BY utc_day;
