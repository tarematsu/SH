import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repairBranch = 'apply-production-d1-repair';
const branch = process.env.WORKERS_CI_BRANCH
  || process.env.CF_PAGES_BRANCH
  || '';

if (branch !== repairBranch) {
  console.log(`Production D1 repair skipped: Cloudflare branch=${branch || '(unknown)'}`);
  process.exit(0);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(workerDirectory, '..');
const configPath = path.join(repositoryRoot, 'site', 'wrangler.jsonc');
const wrangler = process.platform === 'win32'
  ? path.join(workerDirectory, 'node_modules', '.bin', 'wrangler.cmd')
  : path.join(workerDirectory, 'node_modules', '.bin', 'wrangler');

if (!existsSync(wrangler)) throw new Error(`Wrangler executable missing: ${wrangler}`);
if (!existsSync(configPath)) throw new Error(`Pages Wrangler config missing: ${configPath}`);

function run(args, options = {}) {
  const result = spawnSync(wrangler, args, {
    cwd: workerDirectory,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${output}\nwrangler ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

console.log(`Applying production D1 repair from Cloudflare branch ${branch}.`);
run([
  'd1', 'migrations', 'apply', 'stationhead-monitor',
  '--remote', '--config', configPath,
], { stdio: 'inherit', encoding: undefined });

const verificationSql = `SELECT
  (SELECT COUNT(*) FROM sh_legacy_snapshots) AS legacy_rows,
  (SELECT COUNT(*) FROM sh_legacy_samples) AS normalized_rows,
  (SELECT MIN(legacy_id) FROM sh_legacy_samples) AS normalized_min_id,
  (SELECT MAX(legacy_id) FROM sh_legacy_samples) AS normalized_max_id,
  (SELECT legacy_backfill_id FROM sh_data_maintenance_state WHERE id='rollup-retention-v1') AS backfill_cursor,
  (SELECT COUNT(*) FROM d1_migrations WHERE name='100_add_data_maintenance_state.sql') AS migration_100,
  (SELECT COUNT(*) FROM d1_migrations WHERE name='101_add_lightweight_legacy_history.sql') AS migration_101,
  (SELECT COUNT(*) FROM d1_migrations WHERE name='102_add_validated_stream_continuity.sql') AS migration_102,
  (SELECT COUNT(*) FROM d1_migrations WHERE name='103_seed_legacy_backfill.sql') AS migration_103`;
const verification = run([
  'd1', 'execute', 'stationhead-monitor', '--remote', '--config', configPath,
  '--command', verificationSql, '--json',
]);
const parsed = JSON.parse(verification.stdout || '[]');
const envelopes = Array.isArray(parsed) ? parsed : [parsed];
const row = envelopes.flatMap((entry) => entry?.results || entry?.result?.[0]?.results || [])[0];
if (!row) throw new Error('Production D1 repair verification returned no row.');
for (const key of ['migration_100', 'migration_101', 'migration_102', 'migration_103']) {
  if (Number(row[key] || 0) < 1) throw new Error(`Production D1 repair missing ${key}: ${JSON.stringify(row)}`);
}
if (Number(row.normalized_rows || 0) < 1 || Number(row.backfill_cursor || 0) < 1) {
  throw new Error(`Legacy backfill did not start: ${JSON.stringify(row)}`);
}
console.log(`Production D1 repair verified: ${JSON.stringify(row)}`);
