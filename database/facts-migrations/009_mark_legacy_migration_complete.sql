-- Record the completed one-time legacy cutover in the owning database.
-- The 986 source rows that shared a minute bucket were resolved by the
-- existing UNIQUE(channel_id, minute_at) winner policy before the raw archive
-- was removed from OTHER_DB.
INSERT INTO sh_migration_state(
  migration_key,phase,cursor_observed_at,cursor_source_id,migrated_rows,
  error_rows,last_error,metadata_json,updated_at
) VALUES(
  'legacy-minute-facts-v1','completed',
  COALESCE((SELECT MAX(observed_at) FROM sh_minute_facts),0),541289,540303,0,NULL,
  json_object(
    'source_table','sh_legacy_snapshots',
    'source_rows',541289,
    'distinct_minute_buckets',540303,
    'duplicate_bucket_excess',986,
    'winner_policy','minute unique key retained the existing migrated winner',
    'raw_archive','backed_up_before_drop'
  ),
  CAST(strftime('%s','now') AS INTEGER)*1000
)
ON CONFLICT(migration_key) DO UPDATE SET
  phase=excluded.phase,
  cursor_observed_at=excluded.cursor_observed_at,
  cursor_source_id=excluded.cursor_source_id,
  migrated_rows=excluded.migrated_rows,
  error_rows=excluded.error_rows,
  last_error=excluded.last_error,
  metadata_json=excluded.metadata_json,
  updated_at=excluded.updated_at;
