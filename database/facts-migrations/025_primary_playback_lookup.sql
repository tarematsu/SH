-- Bound the public primary-playback lookup to the newest live fact instead of
-- scanning the multi-million-row fact history on every request.
CREATE INDEX IF NOT EXISTS idx_sh_minute_facts_source_minute_desc
ON sh_minute_facts(source_code, minute_at DESC, id DESC);
