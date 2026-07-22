INSERT INTO sh_runtime_analytics_sink
SELECT
  schema_version,
  event_type,
  worker,
  observed_at,
  scheduled_at,
  task_count,
  raw_collection,
  minute_recovery,
  minute_gate,
  stream_prediction,
  maintenance_cron
FROM sh_runtime_analytics_stream
WHERE schema_version = 1
  AND event_type = 'runtime_schedule';
