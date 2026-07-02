CREATE TABLE IF NOT EXISTS sh_health_alert_delivery (
  id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('alert', 'recovery')),
  incident_started_at INTEGER NOT NULL,
  observed_at INTEGER,
  baseline_success_at INTEGER,
  stale_ms INTEGER,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sh_health_alert_delivery_idempotency
  ON sh_health_alert_delivery(idempotency_key);
