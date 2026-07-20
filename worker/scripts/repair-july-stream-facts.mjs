import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// This command is deliberately a remote preflight/arming helper. The actual
// repair is source-verified by sh-monitor-other, which has BUDDIES_DB and
// MINUTE_DB bindings in the same invocation. A local export/import would be
// slower and could overwrite newer rows while the collector is still live.
const workerRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(workerRoot, '..');
const wranglerScript = resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const migrationPath = resolve(repositoryRoot, 'database/facts-migrations/024_minute_fact_repairs.sql');
const databaseName = process.env.FACTS_DATABASE_NAME || 'stationhead-minute';
const apply = process.argv.includes('--apply');

if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required');

function wrangler(args) {
  return execFileSync(process.execPath, [wranglerScript, ...args], {
    cwd: workerRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function parseJsonOutput(output) {
  const trimmed = String(output || '').trim();
  const starts = [trimmed.indexOf('['), trimmed.indexOf('{')].filter((index) => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error(`Wrangler did not return JSON: ${trimmed.slice(0, 300)}`);
  return JSON.parse(trimmed.slice(start));
}

function execute(sql) {
  return wrangler([
    'd1', 'execute', databaseName, '--remote', '--yes', '--json', '--command', sql,
  ]);
}

function rows(output) {
  const parsed = parseJsonOutput(output);
  const containers = Array.isArray(parsed) ? parsed : [parsed];
  return containers.flatMap((container) => container?.results || []);
}

if (apply) {
  wrangler(['d1', 'execute', databaseName, '--remote', '--yes', '--file', migrationPath]);
}

const counts = rows(execute(`SELECT status,COUNT(*) AS count
  FROM sh_minute_fact_repairs
  WHERE repair_key='total-listener-20260710-13-v1'
  GROUP BY status ORDER BY status`));
const suspect = rows(execute(`SELECT COUNT(*) AS count
  FROM sh_minute_facts
  WHERE minute_at>=1783609200000 AND minute_at<1783954800000
    AND reported_total_listens IS NOT NULL AND (
      (reported_current_stream_count IS NOT NULL
        AND reported_current_stream_count=reported_total_listens)
      OR (reported_current_stream_count IS NULL AND (quality_flags & 64) != 0)
    )`));

console.log(JSON.stringify({
  ok: true,
  mode: apply ? 'apply-schema-and-preflight' : 'preflight',
  database_name: databaseName,
  repair_key: 'total-listener-20260710-13-v1',
  suspect_facts: Number(suspect[0]?.count || 0),
  ledger: counts,
  note: 'Deploy sh-monitor-other to run source-verified Queue repairs; summaries follow after pending repairs reach zero.',
}));
