import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

const migrationsUrl = new URL('../../database/migrations/', import.meta.url);
const migrationFiles = readdirSync(migrationsUrl)
  .filter((name) => /^\d+_[A-Za-z0-9._-]+\.sql$/.test(name))
  .sort();
const grandfatheredDuplicateGroups = new Set([
  '005_cloud_host_monitor.sql|005_weekly_summary_foundation.sql',
  '019_collector_failure_diagnostics.sql|019_comment_counts.sql',
]);

function migrationNumber(filename) {
  return filename.match(/^(\d+)_/)?.[1] || null;
}

test('D1 migration numbers have no new duplicate groups', () => {
  const groups = new Map();
  for (const file of migrationFiles) {
    const number = migrationNumber(file);
    const files = groups.get(number) || [];
    files.push(file);
    groups.set(number, files);
  }

  const unexpected = [...groups.entries()]
    .filter(([, files]) => files.length > 1)
    .filter(([, files]) => !grandfatheredDuplicateGroups.has([...files].sort().join('|')))
    .map(([number, files]) => `${number}: ${files.join(', ')}`);
  assert.deepEqual(unexpected, []);
});

test('runtime repair migrations include the complete UTC rebuild chain', () => {
  const required = [
    '100_add_data_maintenance_state.sql',
    '101_add_lightweight_legacy_history.sql',
    '102_add_validated_stream_continuity.sql',
    '103_seed_legacy_backfill.sql',
    '104_stream_goal_prediction_state.sql',
    '106_backfill_missing_daily_summaries.sql',
    '107_add_utc_metric_history_view.sql',
    '108_add_utc_legacy_metric_view.sql',
    '109_add_combined_utc_metric_view.sql',
    '110_add_utc_daily_metric_view.sql',
    '111_rebuild_daily_summaries_utc.sql',
    '112_add_utc_weekly_metric_view.sql',
    '120_rebuild_weekly_summaries_utc.sql',
    '125_add_utc_monthly_metric_view.sql',
    '126_rebuild_monthly_summaries_utc.sql',
  ];
  for (const file of required) assert.equal(migrationFiles.includes(file), true, file);

  const removedConflicts = [
    '034_add_data_maintenance_state.sql',
    '035_add_lightweight_legacy_snapshots.sql',
    '036_add_validated_stream_count.sql',
    '037_rescope_validated_stream_history.sql',
    '038_apply_validated_stream_values.sql',
    '039_enforce_validated_current_stream.sql',
  ];
  for (const file of removedConflicts) assert.equal(migrationFiles.includes(file), false, file);
});
