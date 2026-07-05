ALTER TABLE sh_channel_snapshots
  ADD COLUMN validated_stream_count INTEGER;

ALTER TABLE sh_snapshot_current
  ADD COLUMN last_stream_count INTEGER;

ALTER TABLE sh_snapshot_current
  ADD COLUMN last_stream_at INTEGER;

UPDATE sh_channel_snapshots
SET validated_stream_count=COALESCE(current_stream_count,total_listens)
WHERE validated_stream_count IS NULL;

WITH ordered AS (
  SELECT id,validated_stream_count AS value,
    LAG(validated_stream_count) OVER (
      PARTITION BY COALESCE(CAST(channel_id AS TEXT),'station:' || COALESCE(CAST(station_id AS TEXT),'0'))
      ORDER BY observed_at,id
    ) AS previous_value,
    LEAD(validated_stream_count) OVER (
      PARTITION BY COALESCE(CAST(channel_id AS TEXT),'station:' || COALESCE(CAST(station_id AS TEXT),'0'))
      ORDER BY observed_at,id
    ) AS next_value
  FROM sh_channel_snapshots
  WHERE validated_stream_count IS NOT NULL
), isolated_outliers AS (
  SELECT id FROM ordered
  WHERE previous_value IS NOT NULL AND next_value IS NOT NULL
    AND ABS(value-previous_value)>MAX(50000,ABS(previous_value)*0.5)
    AND ABS(value-next_value)>MAX(50000,ABS(next_value)*0.5)
    AND ABS(next_value-previous_value)<=MAX(10000,ABS(previous_value)*0.1)
)
UPDATE sh_channel_snapshots
SET validated_stream_count=NULL
WHERE id IN (SELECT id FROM isolated_outliers);

UPDATE sh_channel_snapshots
SET current_stream_count=validated_stream_count,
    total_listens=validated_stream_count;

UPDATE sh_snapshot_current
SET last_stream_count=(
      SELECT s.validated_stream_count
      FROM sh_channel_snapshots s
      WHERE s.validated_stream_count IS NOT NULL
        AND (
          CAST(s.channel_id AS TEXT)=sh_snapshot_current.channel_key
          OR ('station:' || COALESCE(s.station_id,0))=sh_snapshot_current.channel_key
        )
      ORDER BY s.observed_at DESC,s.id DESC
      LIMIT 1
    ),
    last_stream_at=(
      SELECT s.observed_at
      FROM sh_channel_snapshots s
      WHERE s.validated_stream_count IS NOT NULL
        AND (
          CAST(s.channel_id AS TEXT)=sh_snapshot_current.channel_key
          OR ('station:' || COALESCE(s.station_id,0))=sh_snapshot_current.channel_key
        )
      ORDER BY s.observed_at DESC,s.id DESC
      LIMIT 1
    )
WHERE last_stream_count IS NULL OR last_stream_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_sh_channel_snapshots_validated_stream
AFTER INSERT ON sh_channel_snapshots
WHEN NEW.current_stream_count IS NOT NEW.validated_stream_count
BEGIN
  UPDATE sh_channel_snapshots
  SET current_stream_count=NEW.validated_stream_count
  WHERE id=NEW.id;
END;
