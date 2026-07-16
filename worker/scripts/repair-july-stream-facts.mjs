import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const workerRoot = resolve(import.meta.dirname, '..');
const wranglerScript = resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const databaseName = process.env.FACTS_DATABASE_NAME || 'stationhead-minute';
const repairKey = '016_repair_july_stream_facts';

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

function execute(sql, json = false) {
  const args = ['d1', 'execute', databaseName, '--remote', '--yes'];
  if (json) args.push('--json');
  args.push('--command', sql);
  return wrangler(args);
}

const contaminatedWhere = `date(minute_at / 1000, 'unixepoch', '+9 hours') BETWEEN '2026-07-10' AND '2026-07-13'
  AND reported_current_stream_count IS NOT NULL
  AND reported_total_listens IS NOT NULL
  AND reported_current_stream_count = reported_total_listens`;

execute(`CREATE TABLE IF NOT EXISTS sh_facts_storage_repairs (
  repair_key TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`);

execute(`UPDATE sh_minute_facts
SET reported_current_stream_count=NULL,
    quality_flags=quality_flags | 64,
    quality_score_code=CASE WHEN quality_score_code>10 THEN quality_score_code-10 ELSE 0 END
WHERE ${contaminatedWhere}
  AND NOT EXISTS (
    SELECT 1 FROM sh_facts_storage_repairs WHERE repair_key='${repairKey}'
  )`);

execute(`INSERT OR IGNORE INTO sh_facts_storage_repairs(repair_key,applied_at)
VALUES('${repairKey}',CAST(strftime('%s','now') AS INTEGER)*1000)`);

const verification = parseJsonOutput(execute(`SELECT COUNT(*) AS contaminated_count
FROM sh_minute_facts WHERE ${contaminatedWhere}`, true));
const containers = Array.isArray(verification) ? verification : [verification];
const row = containers.flatMap((container) => container?.results || [])[0] || {};
const contaminatedCount = Number(row.contaminated_count || 0);
if (contaminatedCount !== 0) {
  throw new Error(`July stream fact repair incomplete: ${contaminatedCount} contaminated rows remain`);
}

console.log(JSON.stringify({ ok: true, database_name: databaseName, repair_key: repairKey }));
