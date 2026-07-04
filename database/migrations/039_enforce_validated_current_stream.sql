CREATE TRIGGER IF NOT EXISTS trg_sh_channel_snapshots_validated_stream
AFTER INSERT ON sh_channel_snapshots
WHEN NEW.current_stream_count IS NOT NEW.validated_stream_count
BEGIN
  UPDATE sh_channel_snapshots
  SET current_stream_count=NEW.validated_stream_count
  WHERE id=NEW.id;
END;
