-- Sent Queue messages no longer need their transport payload in BUDDIES_DB.
-- Keep the job id and delivery metadata for idempotency/operations, while
-- replacing the already-durable payload with a small non-NULL sentinel.
UPDATE sh_minute_fact_outbox
SET payload_json = '{}'
WHERE status = 'sent'
  AND payload_json <> '{}';
