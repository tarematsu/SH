import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const force = String(process.env.D1_MIGRATION_FORCE || '').toLowerCase() === 'true';
const currentBranch = process.env.CF_PAGES_BRANCH || process.env.WORKERS_CI_BRANCH || '';
const cloudflareBuild = process.env.CF_PAGES === '1' || process.env.WORKERS_CI === '1';
const production = currentBranch === 'main';
if (!force && !production) {
  const source = process.env.CF_PAGES_BRANCH ? 'CF_PAGES_BRANCH'
    : process.env.WORKERS_CI_BRANCH ? 'WORKERS_CI_BRANCH' : 'branch variable';
  if (cloudflareBuild && !currentBranch) {
    console.error('D1 schema verification failed: Cloudflare build branch variable is missing.');
    process.exit(1);
  }
  console.log(`D1 schema verification skipped: ${source}=${currentBranch || '(not set)'}`);
  process.exit(0);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const siteDirectory = path.resolve(scriptDirectory, '..');
const wranglerConfigPath = path.join(siteDirectory, 'wrangler.jsonc');
const wranglerExecutable = process.platform === 'win32'
  ? path.join(siteDirectory, 'node_modules', '.bin', 'wrangler.cmd')
  : path.join(siteDirectory, 'node_modules', '.bin', 'wrangler');

if (!existsSync(wranglerExecutable)) {
  console.error('D1 schema verification failed: Wrangler is not installed.');
  process.exit(1);
}

const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_BUILDS_API_TOKEN || '';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '';
if (!apiToken) {
  if (cloudflareBuild && !force) {
    console.warn('D1 schema verification skipped: this Cloudflare build has no API token; runtime schema bootstrap will verify availability through live use.');
    process.exit(0);
  }
  console.error('D1 schema verification failed: Cloudflare API token is missing.');
  process.exit(1);
}

const sql = `SELECT
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_snapshot_current') AS snapshot_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_queue_current') AS queue_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_playback_channel_current') AS playback_current_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_track_like_current') AS likes_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_comment_state') AS comment_state_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_comment_minute_counts') AS comment_minute_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_data_maintenance_state') AS maintenance_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_legacy_samples') AS legacy_samples_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_legacy_hosts') AS legacy_hosts_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_legacy_tracks') AS legacy_tracks_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_legacy_broadcasts') AS legacy_broadcasts_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_stream_goal_prediction_state') AS prediction_state_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='view' AND name='sh_legacy_history_rows') AS legacy_history_view,
  (SELECT COUNT(*) FROM pragma_table_info('sh_queue_current') WHERE name='likes_hash') AS likes_hash_column,
  (SELECT COUNT(*) FROM pragma_table_info('sh_channel_snapshots') WHERE name='validated_stream_count') AS validated_stream_column,
  (SELECT COUNT(*) FROM pragma_table_info('sh_snapshot_current') WHERE name='last_stream_count') AS last_stream_count_column,
  (SELECT COUNT(*) FROM pragma_table_info('sh_snapshot_current') WHERE name='last_stream_at') AS last_stream_at_column,
  (SELECT COUNT(*) FROM pragma_table_info('sh_data_maintenance_state') WHERE name='legacy_backfill_id') AS legacy_backfill_column,
  (SELECT COUNT(*) FROM pragma_index_list('sh_queue_items') WHERE origin='u') AS queue_unique_index,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_sh_channel_snapshots_latest') AS snapshot_index,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='trg_sh_channel_snapshots_validated_stream') AS validated_stream_trigger,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_sh_queue_items_station_start_position') AS redundant_queue_index,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_sh_track_metadata_spotify_fetched') AS redundant_metadata_index`;

const result = spawnSync(wranglerExecutable, [
  'd1', 'execute', 'stationhead-monitor', '--remote', '--config', wranglerConfigPath,
  '--command', sql, '--json',
], {
  cwd: siteDirectory,
  encoding: 'utf8',
  env: {
    ...process.env,
    CI: 'true',
    CLOUDFLARE_API_TOKEN: apiToken,
    ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
  },
});

if (result.status !== 0) {
  console.error(result.stderr || result.stdout || `Wrangler exited ${result.status}`);
  process.exit(result.status ?? 1);
}

const parsed = JSON.parse(result.stdout || '[]');
const envelopes = Array.isArray(parsed) ? parsed : [parsed];
const row = envelopes.flatMap((entry) => entry?.results || entry?.result?.[0]?.results || [])[0];
if (!row) {
  console.error('D1 schema verification failed: no verification row returned.');
  process.exit(1);
}

const required = [
  'snapshot_table', 'queue_table', 'playback_current_table', 'likes_table',
  'comment_state_table', 'comment_minute_table', 'maintenance_table',
  'legacy_samples_table', 'legacy_hosts_table', 'legacy_tracks_table',
  'legacy_broadcasts_table', 'prediction_state_table', 'legacy_history_view',
  'likes_hash_column', 'validated_stream_column', 'last_stream_count_column',
  'last_stream_at_column', 'legacy_backfill_column', 'queue_unique_index',
  'snapshot_index', 'validated_stream_trigger',
];
const missing = required.filter((name) => Number(row[name]) < 1);
const redundant = ['redundant_queue_index', 'redundant_metadata_index']
  .filter((name) => Number(row[name]) !== 0);
if (missing.length || redundant.length) {
  console.error(`D1 schema verification failed: missing=${missing.join(',') || 'none'} redundant=${redundant.join(',') || 'none'}`);
  process.exit(1);
}

console.log('Remote D1 schema verification completed successfully.');
