-- The validated stream-count pipeline was retired in migration 2b99609.
-- Its legacy AFTER INSERT trigger otherwise overwrites the authoritative
-- current_stream_count with NULL whenever validated_stream_count is NULL.
DROP TRIGGER IF EXISTS trg_sh_channel_snapshots_validated_stream;
