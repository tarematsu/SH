import { spawnSync } from 'node:child_process';

const queue = 'stationhead-read-model';
const deadLetterQueue = 'stationhead-read-model-dlq';
const consolidatedScript = 'sh-pages-read-model';
const retiredScript = 'sh-minute-read-model';

function runWrangler(args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    cwd: new URL('..', import.meta.url),
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

function consumerList() {
  const result = runWrangler(
    ['queues', 'consumer', 'worker', 'list', queue, '--json'],
    { capture: true, allowFailure: true },
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

function hasConsumer(scriptName) {
  const result = consumerList();
  return result.ok && result.output.includes(scriptName);
}

function removeConsumer(scriptName, allowFailure = false) {
  runWrangler(['queues', 'consumer', 'worker', 'remove', queue, scriptName], { allowFailure });
}

function restoreRetiredConsumer() {
  runWrangler([
    'queues', 'consumer', 'worker', 'add', queue, retiredScript,
    '--batch-size', '1',
    '--batch-timeout', '1',
    '--message-retries', '8',
    '--dead-letter-queue', deadLetterQueue,
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
    { method, headers: { Authorization: `Bearer ${token}` } },
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

const migrating = hasConsumer(retiredScript);
let paused = false;
let removed = false;
try {
  if (migrating) {
    runWrangler(['queues', 'pause-delivery', queue]);
    paused = true;
    removeConsumer(retiredScript);
    removed = true;
  }
  runWrangler(['deploy', '--config', 'wrangler.pages-read-model.jsonc']);
  if (!hasConsumer(consolidatedScript)) {
    throw new Error(`consolidated read-model consumer missing for ${queue}`);
  }
  if (hasConsumer(retiredScript)) {
    throw new Error(`retired read-model consumer still attached: ${retiredScript}`);
  }
  if (paused) {
    runWrangler(['queues', 'resume-delivery', queue]);
    paused = false;
  }
} catch (error) {
  if (hasConsumer(consolidatedScript)) removeConsumer(consolidatedScript, true);
  if (removed && !hasConsumer(retiredScript)) {
    try { restoreRetiredConsumer(); } catch (rollbackError) {
      console.error(`Failed to restore ${retiredScript}: ${rollbackError.message}`);
    }
  }
  if (paused) {
    try { runWrangler(['queues', 'resume-delivery', queue]); } catch (resumeError) {
      console.error(`Failed to resume ${queue}: ${resumeError.message}`);
    }
  }
  throw error;
}

await deleteRetiredWorker();
console.log(JSON.stringify({
  event: 'read_model_worker_consolidation_completed',
  script: consolidatedScript,
  queue,
  retired_script: retiredScript,
}));
