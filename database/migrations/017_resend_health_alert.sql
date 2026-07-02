CREATE TABLE IF NOT EXISTS sh_health_alert_state (
  id TEXT PRIMARY KEY,
  incident_open INTEGER NOT NULL DEFAULT 0 CHECK (incident_open IN (0, 1)),
  incident_started_at INTEGER,
  last_alert_at INTEGER,
  last_recovery_at INTEGER,
  last_observed_success_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO sh_health_alert_state (
  id,
  incident_open,
  incident_started_at,
  last_alert_at,
  last_recovery_at,
  last_observed_success_at,
  last_error,
  updated_at
) VALUES (
  'stationhead-collector',
  0,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
