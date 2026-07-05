INSERT OR IGNORE INTO sh_legacy_hosts(host_key,handle)
SELECT lower(trim(host_handle)),MIN(host_handle)
FROM sh_legacy_snapshots
WHERE id<=COALESCE((
    SELECT MAX(id) FROM (
      SELECT id FROM sh_legacy_snapshots
      WHERE id>COALESCE((
        SELECT legacy_backfill_id FROM sh_data_maintenance_state
        WHERE id='rollup-retention-v1'
      ),0)
      ORDER BY id ASC LIMIT 5000
    )
  ),0)
  AND id>COALESCE((
    SELECT legacy_backfill_id FROM sh_data_maintenance_state
    WHERE id='rollup-retention-v1'
  ),0)
  AND host_handle IS NOT NULL AND trim(host_handle)<>''
GROUP BY lower(trim(host_handle));

INSERT OR IGNORE INTO sh_legacy_tracks(track_key,title,artist_name)
SELECT
  lower(trim(COALESCE(track_title,''))) || char(31) || lower(trim(COALESCE(artist_name,''))),
  MIN(track_title),MIN(artist_name)
FROM sh_legacy_snapshots
WHERE id<=COALESCE((
    SELECT MAX(id) FROM (
      SELECT id FROM sh_legacy_snapshots
      WHERE id>COALESCE((
        SELECT legacy_backfill_id FROM sh_data_maintenance_state
        WHERE id='rollup-retention-v1'
      ),0)
      ORDER BY id ASC LIMIT 5000
    )
  ),0)
  AND id>COALESCE((
    SELECT legacy_backfill_id FROM sh_data_maintenance_state
    WHERE id='rollup-retention-v1'
  ),0)
  AND (trim(COALESCE(track_title,''))<>'' OR trim(COALESCE(artist_name,''))<>'')
GROUP BY lower(trim(COALESCE(track_title,''))) || char(31) || lower(trim(COALESCE(artist_name,'')));

INSERT OR IGNORE INTO sh_legacy_broadcasts(broadcast_key,event_name,host_id)
SELECT
  lower(trim(l.source_note)) || char(31) || lower(trim(COALESCE(l.host_handle,''))),
  MIN(l.source_note),MIN(h.id)
FROM sh_legacy_snapshots l
LEFT JOIN sh_legacy_hosts h ON h.host_key=lower(trim(l.host_handle))
WHERE l.id<=COALESCE((
    SELECT MAX(id) FROM (
      SELECT id FROM sh_legacy_snapshots
      WHERE id>COALESCE((
        SELECT legacy_backfill_id FROM sh_data_maintenance_state
        WHERE id='rollup-retention-v1'
      ),0)
      ORDER BY id ASC LIMIT 5000
    )
  ),0)
  AND l.id>COALESCE((
    SELECT legacy_backfill_id FROM sh_data_maintenance_state
    WHERE id='rollup-retention-v1'
  ),0)
  AND l.source_note IS NOT NULL AND trim(l.source_note)<>''
GROUP BY lower(trim(l.source_note)) || char(31) || lower(trim(COALESCE(l.host_handle,'')));

INSERT OR IGNORE INTO sh_legacy_samples(
  legacy_id,observed_at,observed_jst,listener_count,total_stream_count,
  track_id,likes,comment_velocity,host_id,total_member_count,broadcast_id,
  quality_score,quality_flags
)
SELECT
  l.id,l.observed_at,l.observed_jst,l.listener_count,l.total_stream_count,
  t.id,l.likes,l.comment_velocity,h.id,l.total_member_count,b.id,
  COALESCE(l.quality_score,1),COALESCE(l.quality_flags,'[]')
FROM sh_legacy_snapshots l
LEFT JOIN sh_legacy_hosts h ON h.host_key=lower(trim(l.host_handle))
LEFT JOIN sh_legacy_tracks t ON t.track_key=(
  lower(trim(COALESCE(l.track_title,''))) || char(31) || lower(trim(COALESCE(l.artist_name,'')))
)
LEFT JOIN sh_legacy_broadcasts b ON b.broadcast_key=(
  lower(trim(l.source_note)) || char(31) || lower(trim(COALESCE(l.host_handle,'')))
)
WHERE l.id<=COALESCE((
    SELECT MAX(id) FROM (
      SELECT id FROM sh_legacy_snapshots
      WHERE id>COALESCE((
        SELECT legacy_backfill_id FROM sh_data_maintenance_state
        WHERE id='rollup-retention-v1'
      ),0)
      ORDER BY id ASC LIMIT 5000
    )
  ),0)
  AND l.id>COALESCE((
    SELECT legacy_backfill_id FROM sh_data_maintenance_state
    WHERE id='rollup-retention-v1'
  ),0);

INSERT INTO sh_data_maintenance_state(
  id,last_rollup_key,last_cleanup_at,legacy_backfill_id,updated_at
)
SELECT
  'rollup-retention-v1',NULL,0,
  COALESCE((SELECT MAX(legacy_id) FROM sh_legacy_samples),0),
  CAST(strftime('%s','now') AS INTEGER)*1000
ON CONFLICT(id) DO UPDATE SET
  legacy_backfill_id=MAX(sh_data_maintenance_state.legacy_backfill_id,excluded.legacy_backfill_id),
  updated_at=excluded.updated_at;
