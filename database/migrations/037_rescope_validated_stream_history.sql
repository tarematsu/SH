UPDATE sh_channel_snapshots
SET validated_stream_count=COALESCE(current_stream_count,total_listens);

WITH ordered AS (
  SELECT id,validated_stream_count AS value,
    LAG(validated_stream_count) OVER (
      PARTITION BY COALESCE(CAST(channel_id AS TEXT),CAST(station_id AS TEXT))
      ORDER BY observed_at,id
    ) AS previous_value,
    LEAD(validated_stream_count) OVER (
      PARTITION BY COALESCE(CAST(channel_id AS TEXT),CAST(station_id AS TEXT))
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
