import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BUDDIES_DATA_TABLES } from './buddies-db-tables.mjs';
import {
  canonicalizeD1Export,
  ownershipPolicyRequiresCleanup,
} from './buddies-db-export.mjs';

const workerRoot = resolve(import.meta.dirname, '..');
const wranglerScript = resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const source = process.env.BUDDIES_SOURCE_DATABASE_NAME || 'stationhead-monitor';
const target = process.env.BUDDIES_DATABASE_NAME || 'stationhead-buddies';
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) || 'verify';

if (!['seed', 'finalize', 'verify'].includes(mode)) {
  throw new Error('Usage: node scripts/sync-buddies-db.mjs --mode=seed|finalize|verify');
}
if (source === target) throw new Error('Source and target databases must be different');
if (mode !== 'verify' && process.env.BUDDIES_TARGET_WRITES_DISABLED !== 'true') {
  throw new Error('Refusing to replace target data unless BUDDIES_TARGET_WRITES_DISABLED=true');
}
if (mode === 'finalize' && process.env.BUDDIES_SOURCE_QUIESCED !== 'true') {
  throw new Error('Final sync requires BUDDIES_SOURCE_QUIESCED=true after the old collector cron is stopped');
}

function wrangler(args) {
  return execFileSync(process.execPath, [wranglerScript, ...args], {
    cwd: workerRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function exportData(database, output) {
  const args = ['d1', 'export', database, '--remote', '--skip-confirmation', '--no-schema', '--output', output];
  for (const table of BUDDIES_DATA_TABLES) args.push('--table', table);
  wrangler(args);
}

function normalizedExport(path) {
  return canonicalizeD1Export(readFileSync(path, 'utf8'))
    .split('\n')
    .filter((statement) => {
      if (statement.startsWith('sh_worker_collector_state|')) return statement.includes("|id='stationhead'|");
      if (statement.startsWith('sh_worker_auth_control|')) return statement.includes("|id='stationhead'|");
      if (statement.startsWith('sh_collector_heartbeats|')) {
        return statement.includes("|collector_id='cloudflare-worker'|");
      }
      return !statement.startsWith('sh_data_maintenance_state|');
    })
    .join('\n');
}

function digest(path) {
  return createHash('sha256').update(normalizedExport(path)).digest('hex');
}

function exportCounts(path) {
  const statements = normalizedExport(path).split('\n').filter(Boolean);
  return Object.fromEntries(BUDDIES_DATA_TABLES.map((table) => [
    table,
    statements.filter((statement) => statement.startsWith(`${table}|`)).length,
  ]));
}

function parseJsonOutput(output) {
  const trimmed = String(output || '').trim();
  const starts = [trimmed.indexOf('['), trimmed.indexOf('{')].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error(`Wrangler did not return JSON: ${trimmed.slice(0, 300)}`);
  return JSON.parse(trimmed.slice(start));
}

function applyOwnershipPolicy() {
  const cleanup = `
    DELETE FROM sh_worker_collector_state WHERE id<>'stationhead';
    DELETE FROM sh_worker_auth_control WHERE id<>'stationhead';
    DELETE FROM sh_collector_heartbeats WHERE collector_id<>'cloudflare-worker';
    DELETE FROM sh_data_maintenance_state;
    DELETE FROM sh_primary_run_lock;`;
  wrangler(['d1', 'execute', target, '--remote', '--yes', '--command', cleanup]);
}

function verifyOwnershipPolicy() {
  const output = wrangler([
    'd1', 'execute', target, '--remote', '--yes', '--json', '--command', `SELECT
      (SELECT COUNT(*) FROM sh_worker_collector_state WHERE id<>'stationhead') AS invalid_collector_state,
      (SELECT COUNT(*) FROM sh_worker_auth_control WHERE id<>'stationhead') AS invalid_auth_control,
      (SELECT COUNT(*) FROM sh_collector_heartbeats WHERE collector_id<>'cloudflare-worker') AS invalid_heartbeat,
      (SELECT COUNT(*) FROM sh_data_maintenance_state) AS maintenance_rows,
      (SELECT COUNT(*) FROM sh_primary_run_lock) AS run_locks`,
  ]);
  const parsed = parseJsonOutput(output);
  const policy = (Array.isArray(parsed) ? parsed : [parsed])
    .flatMap((container) => container?.results || [])[0] || {};
  if (Object.values(policy).some((value) => Number(value) !== 0)) {
    throw new Error(`Buddies ownership policy verification failed: ${JSON.stringify(policy)}`);
  }
  return policy;
}

const directory = mkdtempSync(join(tmpdir(), 'buddies-d1-sync-'));
const sourceExport = join(directory, 'source.sql');
const targetExport = join(directory, 'target.sql');
const copySql = join(directory, 'copy.sql');

try {
  exportData(source, sourceExport);

  if (mode !== 'verify') {
    const deletes = [...BUDDIES_DATA_TABLES].reverse()
      .map((table) => `DELETE FROM "${table}";`)
      .join('\n');
    const exportedData = readFileSync(sourceExport, 'utf8')
      .replace(/^PRAGMA defer_foreign_keys=TRUE;\s*/u, '');
    writeFileSync(copySql, `PRAGMA defer_foreign_keys=TRUE;\n${deletes}\n${exportedData}`);
    wrangler(['d1', 'execute', target, '--remote', '--yes', '--file', copySql]);
  }

  // Remove credentials and auxiliary state owned by other. The target is
  // still offline here, so cleanup is complete before any buddies execution.
  if (ownershipPolicyRequiresCleanup(mode)) applyOwnershipPolicy();
  const ownershipPolicy = verifyOwnershipPolicy();

  exportData(target, targetExport);
  const sourceCounts = exportCounts(sourceExport);
  const targetCounts = exportCounts(targetExport);
  const countMismatches = BUDDIES_DATA_TABLES
    .filter((table) => sourceCounts[table] !== targetCounts[table])
    .map((table) => ({ table, source: sourceCounts[table], target: targetCounts[table] }));
  const sourceDigest = digest(sourceExport);
  const targetDigest = digest(targetExport);
  if (countMismatches.length || sourceDigest !== targetDigest) {
    throw new Error(`Buddies DB verification failed: ${JSON.stringify({ countMismatches, sourceDigest, targetDigest })}`);
  }
  console.log(JSON.stringify({
    ok: true,
    mode,
    source,
    target,
    rows: Object.values(sourceCounts).reduce((sum, count) => sum + count, 0),
    digest: sourceDigest,
    counts: sourceCounts,
    ownership_policy: ownershipPolicy,
  }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
