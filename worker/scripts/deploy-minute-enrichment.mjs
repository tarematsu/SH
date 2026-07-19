import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerRoot = fileURLToPath(new URL('..', import.meta.url));
const metadataQueue = 'stationhead-track-metadata';
const metadataDlq = 'stationhead-track-metadata-dlq';
const minuteQueue = 'stationhead-minute-enrichment';
const consolidatedScript = 'sh-minute-enrichment';
const retiredScript = 'sh-track-metadata';

function runWrangler(args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    cwd: workerRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? String(result.stderr || result.stdout || '').trim() : '';
    throw new Error(`wrangler ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function queueConsumers(queue) {
  const result = runWrangler(
    ['queues', 'consumer', 'worker', 'list', queue, '--json'],
    { capture: true },
  );
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function hasConsumer(queue, scriptName) {
  return queueConsumers(queue).includes(scriptName);
}

function removeConsumer(queue, scriptName, allowFailure = false) {
  runWrangler(['queues', 'consumer', 'worker', 'remove', queue, scriptName], { allowFailure });
}

function restoreRetiredConsumer() {
  runWrangler([
    'queues', 'consumer', 'worker', 'add', metadataQueue, retiredScript,
    '--batch-size', '1',
    '--batch-timeout', '1',
    '--message-retries', '8',
    '--dead-letter-queue', metadataDlq,
    '--max-concurrency', '1',
  ]);
}

function credentials() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN
    || process.env.CLOUDFLARE_BUILDS_API_TOKEN
    || process.env.CF_API_TOKEN;
  if (!accountId || !token) throw new Error('Cloudflare account credentials are unavailable');
  return { accountId, token };
}

async function workerRequest(scriptName, method = 'GET') {
  const { accountId, token } = credentials();
  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}${method === 'DELETE' ? '?force=true' : ''}`,
    {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
}

async function deleteRetiredWorker() {
  const response = await workerRequest(retiredScript, 'DELETE');
  const body = await response.json().catch(() => null);
  const notFound = response.status === 404
    || body?.errors?.some((error) => /not found/i.test(String(error?.message || '')));
  if ((!response.ok || body?.success === false) && !notFound) {
    const detail = body?.errors?.map((error) => error?.message).filter(Boolean).join('; ')
      || `HTTP ${response.status}`;
    throw new Error(`retired Worker ${retiredScript} deletion failed: ${detail}`);
  }
  const verification = await workerRequest(retiredScript);
  if (verification.status !== 404) {
    throw new Error(`retired Worker ${retiredScript} is still reachable: HTTP ${verification.status}`);
  }
}

const migrating = hasConsumer(metadataQueue, retiredScript);
const consolidatedBefore = hasConsumer(metadataQueue, consolidatedScript);
let paused = false;
let removed = false;
try {
  if (migrating) {
    runWrangler(['queues', 'pause-delivery', metadataQueue]);
    paused = true;
    removeConsumer(metadataQueue, retiredScript);
    removed = true;
  }

  runWrangler(['deploy', '--config', 'wrangler.minute-enrichment.jsonc']);
  if (!hasConsumer(minuteQueue, consolidatedScript)) {
    throw new Error(`minute enrichment consumer missing for ${minuteQueue}`);
  }
  if (!hasConsumer(metadataQueue, consolidatedScript)) {
    throw new Error(`consolidated metadata consumer missing for ${metadataQueue}`);
  }
  if (hasConsumer(metadataQueue, retiredScript)) {
    throw new Error(`retired metadata consumer still attached: ${retiredScript}`);
  }
  if (paused) {
    runWrangler(['queues', 'resume-delivery', metadataQueue]);
    paused = false;
  }
} catch (error) {
  if (!consolidatedBefore && hasConsumer(metadataQueue, consolidatedScript)) {
    removeConsumer(metadataQueue, consolidatedScript, true);
  }
  if (removed && !hasConsumer(metadataQueue, retiredScript)) {
    try { restoreRetiredConsumer(); } catch (rollbackError) {
      console.error(`Failed to restore ${retiredScript}: ${rollbackError.message}`);
    }
  }
  if (paused) {
    try { runWrangler(['queues', 'resume-delivery', metadataQueue]); } catch (resumeError) {
      console.error(`Failed to resume ${metadataQueue}: ${resumeError.message}`);
    }
  }
  throw error;
}

await deleteRetiredWorker();
console.log(JSON.stringify({
  event: 'track_metadata_worker_consolidation_completed',
  script: consolidatedScript,
  queue: metadataQueue,
  retired_script: retiredScript,
}));
