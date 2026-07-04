import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

const apiToken = process.env.CLOUDFLARE_API_TOKEN
  || process.env.CLOUDFLARE_BUILDS_API_TOKEN
  || '';
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  || process.env.CF_ACCOUNT_ID
  || '';
if (!apiToken) {
  console.error('D1 schema verification failed: Cloudflare API token is missing.');
  process.exit(1);
}

const sql = `SELECT
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_snapshot_current') AS snapshot_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_queue_current') AS queue_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_track_like_current') AS likes_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_comment_state') AS comment_state_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sh_comment_minute_counts') AS comment_minute_table,
  (SELECT COUNT(*) FROM pragma_table_info('sh_queue_current') WHERE name='likes_hash') AS likes_hash_column,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_sh_queue_items_station_start_position') AS queue_index,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_sh_channel_snapshots_latest') AS snapshot_index`;

const result = spawnSync(wranglerExecutable, [
  'd1', 'execute', 'stationhead-monitor', '--remote',
  '--config', wranglerConfigPath, '--command', sql, '--json',
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

const missing = Object.entries(row)
  .filter(([, value]) => Number(value) !== 1)
  .map(([name]) => name);
if (missing.length) {
  console.error(`D1 schema verification failed: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('Remote D1 schema verification completed successfully.');
