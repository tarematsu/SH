CREATE TABLE IF NOT EXISTS sh_worker_auth_control (
  id TEXT PRIMARY KEY,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO sh_worker_auth_control (id, updated_at)
VALUES ('stationhead', CAST(strftime('%s','now') AS INTEGER) * 1000);
