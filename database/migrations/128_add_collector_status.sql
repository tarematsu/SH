CREATE TABLE IF NOT EXISTS sh_collector_status (
  collector_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_error TEXT,
  failure_code TEXT,
  failure_stage TEXT,
  failure_summary TEXT,
  failure_hint TEXT,
  tracks INTEGER,
  changed INTEGER,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO sh_collector_status (
  collector_id,status,last_attempt_at,last_success_at,last_error,
  failure_code,failure_stage,failure_summary,failure_hint,tracks,changed,updated_at
)
SELECT
  collector_id,
  COALESCE(json_extract(metadata_json,'$.status'),'unknown'),
  COALESCE(json_extract(metadata_json,'$.last_attempt_at'),last_seen_at),
  json_extract(metadata_json,'$.last_success_at'),
  json_extract(metadata_json,'$.last_error'),
  json_extract(metadata_json,'$.failure_code'),
  json_extract(metadata_json,'$.failure_stage'),
  json_extract(metadata_json,'$.failure_summary'),
  json_extract(metadata_json,'$.failure_hint'),
  json_extract(metadata_json,'$.tracks'),
  CASE json_extract(metadata_json,'$.changed') WHEN 1 THEN 1 ELSE 0 END,
  last_seen_at
FROM sh_collector_heartbeats
WHERE collector_id LIKE '%-playback';
