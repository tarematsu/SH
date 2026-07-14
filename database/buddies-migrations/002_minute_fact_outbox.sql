-- Durable handoff from the isolated buddies collector to Cloudflare Queues.
-- A failed Queue send leaves the row pending for a later collector run.

CREATE TABLE IF NOT EXISTS sh_minute_fact_outbox (
  job_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'sent')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  last_attempt_at INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_outbox_pending
  ON sh_minute_fact_outbox(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_sh_minute_fact_outbox_sent
  ON sh_minute_fact_outbox(sent_at ASC)
  WHERE status='sent';
