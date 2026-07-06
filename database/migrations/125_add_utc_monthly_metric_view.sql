CREATE VIEW IF NOT EXISTS sh_monthly_metric_utc AS
WITH ranked AS (
  SELECT sh_daily_summary.*,
    substr(period_key,1,7) AS utc_month,
    ROW_NUMBER() OVER (PARTITION BY substr(period_key,1,7) ORDER BY (stream_start IS NULL),period_key) AS stream_first_rank,
    ROW_NUMBER() OVER (PARTITION BY substr(period_key,1,7) ORDER BY (stream_end IS NULL),period_key DESC) AS stream_last_rank,
    ROW_NUMBER() OVER (PARTITION BY substr(period_key,1,7) ORDER BY (member_start IS NULL),period_key) AS member_first_rank,
    ROW_NUMBER() OVER (PARTITION BY substr(period_key,1,7) ORDER BY (member_end IS NULL),period_key DESC) AS member_last_rank
  FROM sh_daily_summary
)
SELECT utc_month AS period_key,MIN(period_start) AS period_start,MAX(period_end) AS period_end,
  SUM(sample_count) AS sample_count,SUM(reliable_sample_count) AS reliable_sample_count,
  SUM(listener_avg*reliable_sample_count)/NULLIF(SUM(CASE WHEN listener_avg IS NOT NULL THEN reliable_sample_count ELSE 0 END),0) AS listener_avg,
  MIN(listener_min) AS listener_min,MAX(listener_max) AS listener_max,
  MAX(CASE WHEN stream_first_rank=1 THEN stream_start END) AS stream_start,
  MAX(CASE WHEN stream_last_rank=1 THEN stream_end END) AS stream_end,
  MAX(CASE WHEN member_first_rank=1 THEN member_start END) AS member_start,
  MAX(CASE WHEN member_last_rank=1 THEN member_end END) AS member_end,
  MAX(likes_max) AS likes_max
FROM ranked GROUP BY utc_month;
