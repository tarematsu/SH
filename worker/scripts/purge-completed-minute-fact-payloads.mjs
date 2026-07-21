import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const workerRoot = resolve(import.meta.dirname, '..');
const wranglerScript = resolve(workerRoot, 'node_modules/wrangler/bin/wrangler.js');
const databaseName = process.env.FACTS_DATABASE_NAME || 'stationhead-minute';
const batchSize = positiveInteger(process.env.MINUTE_FACT_PAYLOAD_PURGE_BATCH_SIZE, 1_000, 5_000);
const maxBatches = positiveInteger(process.env.MINUTE_FACT_PAYLOAD_PURGE_MAX_BATCHES, 10_000, 100_000);

if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required');

function positiveInteger(value, fallback, maximum) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

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

const incompleteRevisionPredicate = `EXISTS (
  SELECT 1 FROM sh_queue_revisions revisions
  WHERE revisions.source_job_id=jobs.id
    AND (revisions.status<>'complete'
      OR COALESCE(revisions.materialized_item_count,0)
        <COALESCE(revisions.source_visible_count,revisions.item_count,0))
)`;

function eligiblePredicate(alias = 'jobs') {
  return `${alias}.status='done' AND LENGTH(${alias}.payload_json)>2
    AND NOT ${incompleteRevisionPredicate.replaceAll('jobs.', `${alias}.`)}`;
}

function stats() {
  const result = rows(execute(`SELECT
      COUNT(*) AS retained_payload_jobs,
      COALESCE(SUM(LENGTH(payload_json)),0) AS retained_payload_chars,
      COALESCE(SUM(CASE WHEN ${eligiblePredicate('jobs')} THEN 1 ELSE 0 END),0) AS eligible_jobs,
      COALESCE(SUM(CASE WHEN jobs.status='done' AND LENGTH(jobs.payload_json)>2
        AND ${incompleteRevisionPredicate} THEN 1 ELSE 0 END),0) AS blocked_by_revision_jobs
    FROM sh_minute_fact_jobs jobs`));
  const row = result[0] || {};
  return {
    retained_payload_jobs: Number(row.retained_payload_jobs || 0),
    retained_payload_chars: Number(row.retained_payload_chars || 0),
    eligible_jobs: Number(row.eligible_jobs || 0),
    blocked_by_revision_jobs: Number(row.blocked_by_revision_jobs || 0),
  };
}

const before = stats();
let clearedJobs = 0;
let batches = 0;

while (batches < maxBatches) {
  const result = rows(execute(`UPDATE sh_minute_fact_jobs SET payload_json='{}'
    WHERE id IN (
      SELECT jobs.id FROM sh_minute_fact_jobs jobs
      WHERE ${eligiblePredicate('jobs')}
      ORDER BY COALESCE(jobs.processed_at,jobs.updated_at) ASC,jobs.id ASC
      LIMIT ${batchSize}
    )
    RETURNING id`));
  const cleared = result.length;
  clearedJobs += cleared;
  batches += 1;
  console.log(JSON.stringify({
    event: 'minute_fact_payload_purge_batch',
    batch: batches,
    cleared,
    cleared_total: clearedJobs,
  }));
  if (cleared < batchSize) break;
}

const after = stats();
if (after.eligible_jobs !== 0) {
  throw new Error(`minute fact payload purge incomplete: ${after.eligible_jobs} eligible jobs remain after ${batches} batches`);
}
if (batches >= maxBatches && after.eligible_jobs > 0) {
  throw new Error(`minute fact payload purge exceeded ${maxBatches} batches`);
}

console.log(JSON.stringify({
  ok: true,
  event: 'minute_fact_payload_purge_complete',
  database_name: databaseName,
  batch_size: batchSize,
  batches,
  cleared_jobs: clearedJobs,
  payload_chars_removed: Math.max(0, before.retained_payload_chars - after.retained_payload_chars),
  before,
  after,
}));
