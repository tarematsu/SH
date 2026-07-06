CREATE VIEW IF NOT EXISTS sh_weekly_metric_utc AS
WITH prepared AS (
  SELECT sh_daily_summary.*,
    date(period_key,'-' || ((CAST(strftime('%w',period_key) AS INTEGER)+6)%7) || ' days') AS utc_week
  FROM sh_daily_summary
), ranked AS (
  SELECT prepared.*,
    ROW_NUMBER() OVER (
      PARTITION BY utc_week
      ORDER BY (stream_start IS NULL) ASC,period_key ASC
    ) AS stream_first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY utc_week
      ORDER BY (stream_end IS NULL) ASC,period_key DESC
    ) AS stream_last_rank,
    ROW_NUMBER() OVER (
      PARTITION BY utc_week
      ORDER BY (member_start IS NULL) ASC,period_key ASC
    ) AS member_first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY utc_week
      ORDER BY (member_end IS NULL) ASC,period_key DESC
    ) AS member_last_rank
  FROM prepared
)
SELECT utc_week AS period_key,
  MIN(period_start) AS period_start,
  MAX(period_end) AS period_end,
  SUM(sample_count) AS sample_count,
  SUM(reliable_sample_count) AS reliable_sample_count,
  SUM(listener_avg*reliable_sample_count)
    /NULLIF(SUM(CASE WHEN listener_avg IS NOT NULL THEN reliable_sample_count ELSE 0 END),0) AS listener_avg,
  MIN(listener_min) AS listener_min,
  MAX(listener_max) AS listener_max,
  MAX(CASE WHEN stream_first_rank=1 THEN stream_start END) AS stream_start,
  MAX(CASE WHEN stream_last_rank=1 THEN stream_end END) AS stream_end,
  MAX(CASE WHEN member_first_rank=1 THEN member_start END) AS member_start,
  MAX(CASE WHEN member_last_rank=1 THEN member_end END) AS member_end,
  MAX(likes_max) AS likes_max
FROM ranked
GROUP BY utc_week;
