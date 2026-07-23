import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const factsDescriptorPath = resolve(repositoryRoot, 'database/facts-db.json');

function positiveInteger(value, fallback, maximum) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function eligiblePredicate(alias = 'jobs') {
  return `${alias}.payload_clearable=1 AND LENGTH(${alias}.payload_json)>2`;
}

function blockedPredicate(alias = 'jobs') {
  return `${alias}.status='done' AND ${alias}.payload_clearable=0
    AND LENGTH(${alias}.payload_json)>2`;
}

export function payloadPurgeStatement(batchSize) {
  const limit = positiveInteger(batchSize, 1_000, 5_000);
  return `UPDATE sh_minute_fact_jobs SET payload_json='{}',payload_clearable=0
    WHERE id IN (
      SELECT jobs.id FROM sh_minute_fact_jobs jobs
      WHERE ${eligiblePredicate('jobs')}
      ORDER BY COALESCE(jobs.processed_at,jobs.updated_at) ASC,jobs.id ASC
      LIMIT ${limit}
    )`;
}

export function payloadPurgeBatch(batchSize, statementCount) {
  const count = positiveInteger(statementCount, 20, 100);
  const sql = payloadPurgeStatement(batchSize);
  return { batch: Array.from({ length: count }, () => ({ sql })) };
}

export function summarizePurgeBatch(results, batchSize) {
  const expected = positiveInteger(batchSize, 1_000, 5_000);
  const changes = (Array.isArray(results) ? results : []).map((result) => {
    const value = Number(result?.meta?.changes || 0);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  });
  return {
    cleared: changes.reduce((total, value) => total + value, 0),
    completed: changes.some((value) => value < expected),
    statements: changes.length,
  };
}

function resultRows(results) {
  return (Array.isArray(results) ? results : []).flatMap((result) => result?.results || []);
}

function errorMessage(body, status, resultFailure = null) {
  const messages = [
    resultFailure?.error && { message: resultFailure.error },
    ...(Array.isArray(body?.errors) ? body.errors : []),
    ...(Array.isArray(body?.messages) ? body.messages : []),
  ]
    .map((entry) => String(entry?.message || '').trim())
    .filter(Boolean);
  return messages.join('; ') || `Cloudflare D1 query failed with HTTP ${status}`;
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function sleep(milliseconds) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function queryD1({
  fetchImpl,
  endpoint,
  apiToken,
  payload,
  maxAttempts,
  retryDelayMs,
}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      const queryResults = Array.isArray(body?.result) ? body.result : [];
      const resultFailure = queryResults.find((result) => result?.success === false);
      if (!response.ok || body?.success === false || resultFailure) {
        const error = new Error(errorMessage(body, response.status, resultFailure));
        error.retryable = retryableStatus(response.status);
        throw error;
      }
      if (!queryResults.length) throw new Error('Cloudflare D1 query returned no results');
      return queryResults;
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable !== false;
      if (!retryable || attempt >= maxAttempts) break;
      const delay = Math.min(retryDelayMs * (2 ** (attempt - 1)), 15_000);
      console.warn(JSON.stringify({
        event: 'minute_fact_payload_purge_retry',
        attempt,
        delay_ms: delay,
        error: String(error?.message || error).slice(0, 500),
      }));
      await sleep(delay);
    }
  }
  throw lastError || new Error('Cloudflare D1 query failed');
}

function readFactsDescriptor() {
  return JSON.parse(readFileSync(factsDescriptorPath, 'utf8'));
}

export async function purgeCompletedMinuteFactPayloads(options = {}) {
  const descriptor = options.descriptor || readFactsDescriptor();
  const accountId = options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = options.apiToken || process.env.CLOUDFLARE_API_TOKEN;
  const databaseId = options.databaseId || process.env.FACTS_DATABASE_ID || descriptor.database_id;
  const databaseName = options.databaseName || process.env.FACTS_DATABASE_NAME || descriptor.database_name;
  const batchSize = positiveInteger(
    options.batchSize ?? process.env.MINUTE_FACT_PAYLOAD_PURGE_BATCH_SIZE,
    1_000,
    5_000,
  );
  const statementsPerRequest = positiveInteger(
    options.statementsPerRequest ?? process.env.MINUTE_FACT_PAYLOAD_PURGE_STATEMENTS_PER_REQUEST,
    20,
    100,
  );
  const maxBatches = positiveInteger(
    options.maxBatches ?? process.env.MINUTE_FACT_PAYLOAD_PURGE_MAX_BATCHES,
    10_000,
    100_000,
  );
  const maxAttempts = positiveInteger(
    options.maxAttempts ?? process.env.MINUTE_FACT_PAYLOAD_PURGE_MAX_ATTEMPTS,
    6,
    10,
  );
  const retryDelayMs = positiveInteger(
    options.retryDelayMs ?? process.env.MINUTE_FACT_PAYLOAD_PURGE_RETRY_DELAY_MS,
    1_000,
    30_000,
  );
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is required');
  if (!databaseId) throw new Error('FACTS_DATABASE_ID or database/facts-db.json database_id is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  let clearedJobs = 0;
  let batches = 0;
  let requests = 0;
  let completed = false;

  while (batches < maxBatches && !completed) {
    const statementCount = Math.min(statementsPerRequest, maxBatches - batches);
    const results = await queryD1({
      fetchImpl,
      endpoint,
      apiToken,
      payload: payloadPurgeBatch(batchSize, statementCount),
      maxAttempts,
      retryDelayMs,
    });
    const progress = summarizePurgeBatch(results, batchSize);
    if (progress.statements !== statementCount) {
      throw new Error(`Cloudflare D1 returned ${progress.statements} results for ${statementCount} purge statements`);
    }
    requests += 1;
    batches += progress.statements;
    clearedJobs += progress.cleared;
    completed = progress.completed;
    console.log(JSON.stringify({
      event: 'minute_fact_payload_purge_batch',
      request: requests,
      batches,
      cleared: progress.cleared,
      cleared_total: clearedJobs,
    }));
  }

  const verificationResults = await queryD1({
    fetchImpl,
    endpoint,
    apiToken,
    payload: {
      batch: [
        {
          sql: `SELECT jobs.id FROM sh_minute_fact_jobs jobs
            WHERE ${eligiblePredicate('jobs')}
            ORDER BY COALESCE(jobs.processed_at,jobs.updated_at) ASC,jobs.id ASC
            LIMIT 1`,
        },
        {
          sql: `SELECT jobs.id FROM sh_minute_fact_jobs jobs
            WHERE ${blockedPredicate('jobs')}
            ORDER BY COALESCE(jobs.processed_at,jobs.updated_at) ASC,jobs.id ASC
            LIMIT 1`,
        },
      ],
    },
    maxAttempts,
    retryDelayMs,
  });
  const remainingEligibleJobId = resultRows([verificationResults[0]])[0]?.id ?? null;
  if (remainingEligibleJobId != null) {
    throw new Error(
      `minute fact payload purge incomplete: job ${remainingEligibleJobId} remains after ${batches} batches`,
    );
  }
  const blockedRevisionPayloadsRemain = resultRows([verificationResults[1]]).length > 0;
  const summary = {
    ok: true,
    event: 'minute_fact_payload_purge_complete',
    database_name: databaseName,
    database_id: databaseId,
    batch_size: batchSize,
    statements_per_request: statementsPerRequest,
    requests,
    batches,
    cleared_jobs: clearedJobs,
    remaining_eligible_job_id: null,
    blocked_revision_payloads_remain: blockedRevisionPayloadsRemain,
  };
  console.log(JSON.stringify(summary));
  return summary;
}

async function main() {
  await purgeCompletedMinuteFactPayloads();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
