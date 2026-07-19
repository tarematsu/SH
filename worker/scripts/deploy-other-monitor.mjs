import { spawnSync } from 'node:child_process';

const consolidatedScript = 'sh-monitor-other';
const migrations = [
  {
    queue: 'stationhead-buddy-playback',
    oldScript: 'sh-buddy-playback',
    deadLetterQueue: 'stationhead-buddy-playback-dlq',
  },
  {
    queue: 'stationhead-host-monitor',
    oldScript: 'sh-host-monitor',
    deadLetterQueue: 'stationhead-host-monitor-dlq',
  },
];
const retiredScripts = [
  ...migrations.map(({ oldScript }) => oldScript),
  'sh-buddies-read-model',
];

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

function consumerList(queue) {
  const result = runWrangler(
    ['queues', 'consumer', 'worker', 'list', queue, '--json'],
    { capture: true, allowFailure: true },
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

function hasConsumer(queue, scriptName) {
  const result = consumerList(queue);
  return result.ok && result.output.includes(scriptName);
}

function assertConsolidatedConsumers() {
  for (const item of migrations) {
    const result = consumerList(item.queue);
    if (!result.ok) throw new Error(`consumer list failed for ${item.queue}`);
    if (!result.output.includes(consolidatedScript)) {
      throw new Error(`consolidated monitor consumer missing for ${item.queue}`);
    }
    if (result.output.includes(item.oldScript)) {
      throw new Error(`retired monitor consumer still attached: ${item.oldScript}`);
    }
  }
}

function pause(queue) {
  runWrangler(['queues', 'pause-delivery', queue]);
}

function resume(queue) {
  runWrangler(['queues', 'resume-delivery', queue]);
}

function removeConsumer(queue, scriptName, { allowFailure = false } = {}) {
  runWrangler(
    ['queues', 'consumer', 'worker', 'remove', queue, scriptName],
    { allowFailure },
  );
}

function restoreOldConsumer(item) {
  runWrangler([
    'queues', 'consumer', 'worker', 'add', item.queue, item.oldScript,
    '--batch-size', '1',
    '--batch-timeout', '1',
    '--message-retries', '8',
    '--dead-letter-queue', item.deadLetterQueue,
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

async function deleteOldWorker(scriptName) {
  const response = await workerRequest(scriptName, 'DELETE');
  const body = await response.json().catch(() => null);
  const notFound = response.status === 404
    || body?.errors?.some((error) => /not found/i.test(String(error?.message || '')));
  if ((!response.ok || body?.success === false) && !notFound) {
    const detail = body?.errors?.map((error) => error?.message).filter(Boolean).join('; ')
      || `HTTP ${response.status}`;
    throw new Error(`retired Worker ${scriptName} deletion failed: ${detail}`);
  }

  const verification = await workerRequest(scriptName);
  if (verification.status !== 404) {
    throw new Error(`retired Worker ${scriptName} is still reachable: HTTP ${verification.status}`);
  }
  console.log(JSON.stringify({
    event: 'retired_monitor_worker_absent',
    script: scriptName,
    already_absent: notFound,
  }));
}

const activeMigrations = migrations.filter((item) => hasConsumer(item.queue, item.oldScript));
const paused = [];
const removed = [];

try {
  for (const item of activeMigrations) {
    pause(item.queue);
    paused.push(item);
    removeConsumer(item.queue, item.oldScript);
    removed.push(item);
  }

  runWrangler(['deploy', '--config', 'wrangler.other.jsonc']);
  assertConsolidatedConsumers();

  for (const item of paused) resume(item.queue);
  paused.length = 0;
} catch (error) {
  for (const item of migrations.toReversed()) {
    if (hasConsumer(item.queue, consolidatedScript)) {
      removeConsumer(item.queue, consolidatedScript, { allowFailure: true });
    }
  }
  for (const item of removed.toReversed()) {
    try {
      if (!hasConsumer(item.queue, item.oldScript)) restoreOldConsumer(item);
    } catch (rollbackError) {
      console.error(`Failed to restore ${item.oldScript}: ${rollbackError.message}`);
    }
  }
  for (const item of paused.toReversed()) {
    try {
      resume(item.queue);
    } catch (resumeError) {
      console.error(`Failed to resume ${item.queue}: ${resumeError.message}`);
    }
  }
  throw error;
}

for (const scriptName of retiredScripts) await deleteOldWorker(scriptName);
assertConsolidatedConsumers();

console.log(JSON.stringify({
  event: 'monitor_worker_consolidation_completed',
  script: consolidatedScript,
  queues: migrations.map((item) => item.queue),
  retired_scripts: retiredScripts,
}));
