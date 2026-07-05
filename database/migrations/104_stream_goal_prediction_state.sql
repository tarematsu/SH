CREATE TABLE IF NOT EXISTS sh_stream_goal_prediction_state (
  id TEXT PRIMARY KEY,
  generated_at INTEGER NOT NULL DEFAULT 0,
  source_observed_at INTEGER,
  goal INTEGER,
  eta INTEGER,
  rate_per_hour REAL,
  remaining INTEGER,
  sample_count INTEGER NOT NULL DEFAULT 0,
  span_hours REAL,
  next_refresh_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sh_stream_goal_prediction_state (
  id, generated_at, sample_count, next_refresh_at, updated_at
) VALUES ('stream-goal-24h', 0, 0, 0, 0);
