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
    maxBuffer: 16 * 1024 * 1024,
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

function incompleteRevisionPredicate(alias = 'jobs') {
  return `EXISTS (
    SELECT 1 FROM sh_queue_revisions revisions
    WHERE revisions.source_job_id=${alias}.id
      AND (revisions.status<>'complete'
        OR COALESCE(revisions.materialized_item_count,0)
          <COALESCE(revisions.source_visible_count,revisions.item_count,0))
  )`;
}

function eligiblePredicate(alias = 'jobs') {
  return `${alias}.status='done' AND LENGTH(${alias}.payload_json)>2
    AND NOT ${incompleteRevisionPredicate(alias)}`;
}

function firstEligibleJobId() {
  const result = rows(execute(`SELECT jobs.id FROM sh_minute_fact_jobs jobs
    WHERE ${eligiblePredicate('jobs')}
    ORDER BY COALESCE(jobs.processed_at,jobs.updated_at) ASC,jobs.id ASC
    LIMIT 1`));
  return result[0]?.id == null ? null : Number(result[0].id);
}

function blockedRevisionPayloadExists() {
  const result = rows(execute(`SELECT jobs.id FROM sh_minute_fact_jobs jobs
    WHERE jobs.status='done' AND LENGTH(jobs.payload_json)>2
      AND ${incompleteRevisionPredicate('jobs')}
    ORDER BY COALESCE(jobs.processed_at,jobs.updated_at) ASC,jobs.id ASC
    LIMIT 1`));
  return result.length > 0;
}

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

const remainingEligibleJobId = firstEligibleJobId();
if (remainingEligibleJobId != null) {
  throw new Error(`minute fact payload purge incomplete: job ${remainingEligibleJobId} remains after ${batches} batches`);
}

console.log(JSON.stringify({
  ok: true,
  event: 'minute_fact_payload_purge_complete',
  database_name: databaseName,
  batch_size: batchSize,
  batches,
  cleared_jobs: clearedJobs,
  remaining_eligible_job_id: null,
  blocked_revision_payloads_remain: blockedRevisionPayloadExists(),
}));
