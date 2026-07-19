import { spawnSync } from 'node:child_process';

const consolidatedScript = 'sh-monitor-other';
const collectorScript = 'sh-buddies-monitor';
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
const retiredBeforeCollector = [
  ...migrations.map(({ oldScript }) => oldScript),
  'sh-buddies-read-model',
  'sh-monitor-maintenance',
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
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`consumer list failed for ${queue}${detail ? `: ${detail}` : ''}`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function hasConsumer(queue, scriptName) {
  return consumerList(queue).includes(scriptName);
}

function assertConsolidatedConsumers() {
  for (const item of migrations) {
    const output = consumerList(item.queue);
    if (!output.includes(consolidatedScript)) {
      throw new Error(`consolidated monitor consumer missing for ${item.queue}`);
    }
    if (output.includes(item.oldScript)) {
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

function rollbackConsolidated() {
  runWrangler([
    'rollback',
    '--name', consolidatedScript,
    '--message', 'Automatic rollback after monitor consolidation cutover failure',
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

function workerNotFound(response, body) {
  return response.status === 404
    || body?.errors?.some((error) => /not found/i.test(String(error?.message || '')));
}

async function verifyWorkerAbsent(scriptName, attempts = 3) {
  let lastStatus = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const verification = await workerRequest(scriptName);
    lastStatus = verification.status;
    if (verification.status === 404) return;
    if (verification.status < 500 || attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  throw new Error(`retired Worker ${scriptName} is still reachable or unverifiable: HTTP ${lastStatus}`);
}

async function deleteOldWorker(scriptName) {
  const response = await workerRequest(scriptName, 'DELETE');
  const body = await response.json().catch(() => null);
  const notFound = workerNotFound(response, body);
  if ((!response.ok || body?.success === false) && !notFound) {
    const detail = body?.errors?.map((error) => error?.message).filter(Boolean).join('; ')
      || `HTTP ${response.status}`;
    throw new Error(`retired Worker ${scriptName} deletion failed: ${detail}`);
  }

  await verifyWorkerAbsent(scriptName);
  console.log(JSON.stringify({
    event: 'retired_monitor_worker_absent',
    script: scriptName,
    already_absent: notFound,
  }));
}

const consolidatedBefore = new Map(
  migrations.map((item) => [item.queue, hasConsumer(item.queue, consolidatedScript)]),
);
const activeMigrations = migrations.filter((item) => hasConsumer(item.queue, item.oldScript));
const paused = [];
const removed = [];
let consolidatedDeployed = false;
let collectorRetired = false;

try {
  for (const item of activeMigrations) {
    pause(item.queue);
    paused.push(item);
    removeConsumer(item.queue, item.oldScript);
    removed.push(item);
  }

  runWrangler(['deploy', '--config', 'wrangler.other.jsonc']);
  consolidatedDeployed = true;
  assertConsolidatedConsumers();

  for (const scriptName of retiredBeforeCollector) await deleteOldWorker(scriptName);
  assertConsolidatedConsumers();

  for (const item of paused) resume(item.queue);
  paused.length = 0;

  // Retire the every-minute collector last. Nothing that can trigger a rollback
  // is allowed after this succeeds, otherwise a rollback could leave collection
  // with neither the old nor consolidated Worker active.
  await deleteOldWorker(collectorScript);
  collectorRetired = true;
} catch (error) {
  const rollbackErrors = [];
  if (consolidatedDeployed && !collectorRetired) {
    try {
      rollbackConsolidated();
    } catch (rollbackError) {
      rollbackErrors.push(`Worker rollback failed: ${rollbackError.message}`);
    }
  }
  for (const item of migrations.toReversed()) {
    try {
      if (!consolidatedBefore.get(item.queue) && hasConsumer(item.queue, consolidatedScript)) {
        removeConsumer(item.queue, consolidatedScript, { allowFailure: true });
      }
    } catch (consumerError) {
      rollbackErrors.push(`Failed to remove ${consolidatedScript} from ${item.queue}: ${consumerError.message}`);
    }
  }
  for (const item of removed.toReversed()) {
    try {
      if (!hasConsumer(item.queue, item.oldScript)) restoreOldConsumer(item);
    } catch (rollbackError) {
      rollbackErrors.push(`Failed to restore ${item.oldScript}: ${rollbackError.message}`);
    }
  }
  for (const item of paused.toReversed()) {
    try {
      resume(item.queue);
    } catch (resumeError) {
      rollbackErrors.push(`Failed to resume ${item.queue}: ${resumeError.message}`);
    }
  }
  if (rollbackErrors.length) {
    throw new AggregateError(
      [error, ...rollbackErrors.map((message) => new Error(message))],
      'monitor consolidation failed and rollback was incomplete',
    );
  }
  throw error;
}

console.log(JSON.stringify({
  event: 'monitor_worker_consolidation_completed',
  script: consolidatedScript,
  queues: migrations.map((item) => item.queue),
  retired_scripts: [...retiredBeforeCollector, collectorScript],
}));
