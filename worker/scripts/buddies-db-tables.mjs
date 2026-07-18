export const BUDDIES_DATA_TABLES = Object.freeze([
  'sh_channel_snapshots',
  'sh_snapshot_current',
  'sh_queue_snapshots',
  'sh_queue_items',
  'sh_queue_current',
  'sh_queue_materialization_state',
  'sh_track_like_current',
  'sh_track_like_observations',
  'sh_track_metadata',
  'sh_comment_state',
  'sh_comment_minute_counts',
  'sh_comment_daily_counts',
  'sh_collector_heartbeats',
  'sh_worker_collector_state',
  'sh_worker_auth_control',
  'sh_collector_failure_state',
  'sh_ingest_claims',
  'sh_ingest_conflicts',
  'sh_data_maintenance_state',
]);

export const BUDDIES_SCHEMA_ONLY_TABLES = Object.freeze([
  'sh_primary_run_lock',
  'sh_minute_fact_outbox',
]);

export const BUDDIES_ALL_TABLES = Object.freeze([
  ...BUDDIES_DATA_TABLES,
  ...BUDDIES_SCHEMA_ONLY_TABLES,
]);
