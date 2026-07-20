import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preparePagesReadModelDeployConfig } from './pages-response-kv-namespace.mjs';

const workerRoot = fileURLToPath(new URL('..', import.meta.url));
const metadataQueue = 'stationhead-track-metadata';
const metadataDlq = 'stationhead-track-metadata-dlq';
const minuteQueue = 'stationhead-minute-enrichment';
const consolidatedScript = 'sh-minute-enrichment';
const migrationSpecs = Object.freeze([
  {
    queue: metadataQueue,
    deadLetterQueue: metadataDlq,
    retiredScript: 'sh-track-metadata',
  },
  {
    queue: 'stationhead-read-model',
    deadLetterQueue: 'stationhead-read-model-dlq',
    retiredScript: 'sh-pages-read-model',
  },
  {
    queue: 'stationhead-pages-read-model-publication',
    deadLetterQueue: 'stationhead-pages-read-model-publication-dlq',
    retiredScript: 'sh-pages-read-model',
  },
]);

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

function restoreRetiredConsumer(spec) {
  runWrangler([
    'queues', 'consumer', 'worker', 'add', spec.queue, spec.retiredScript,
    '--batch-size', '1',
    '--batch-timeout', '1',
    '--message-retries', '8',
    '--dead-letter-queue', spec.deadLetterQueue,
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

async function deleteRetiredWorker(retiredScript) {
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

const deploy = await preparePagesReadModelDeployConfig(workerRoot, {
  sourcePath: `${workerRoot}/wrangler.minute-enrichment.jsonc`,
  temporaryPath: `${workerRoot}/.wrangler.minute-enrichment.deploy-${process.pid}.jsonc`,
});
const migrations = migrationSpecs.map((spec) => ({
  ...spec,
  migrating: hasConsumer(spec.queue, spec.retiredScript),
  consolidatedBefore: hasConsumer(spec.queue, consolidatedScript),
  paused: false,
  removed: false,
}));
try {
  for (const migration of migrations) {
    if (!migration.migrating) continue;
    runWrangler(['queues', 'pause-delivery', migration.queue]);
    migration.paused = true;
    removeConsumer(migration.queue, migration.retiredScript);
    migration.removed = true;
  }

  runWrangler(['deploy', '--config', deploy.configPath]);
  for (const queue of [minuteQueue, ...migrationSpecs.map(({ queue }) => queue)]) {
    if (!hasConsumer(queue, consolidatedScript)) {
      throw new Error(`consolidated consumer missing for ${queue}`);
    }
  }
  for (const migration of migrations) {
    if (hasConsumer(migration.queue, migration.retiredScript)) {
      throw new Error(`retired consumer still attached: ${migration.retiredScript} on ${migration.queue}`);
    }
    if (migration.paused) {
      runWrangler(['queues', 'resume-delivery', migration.queue]);
      migration.paused = false;
    }
  }
} catch (error) {
  for (const migration of migrations) {
    if (!migration.consolidatedBefore && hasConsumer(migration.queue, consolidatedScript)) {
      removeConsumer(migration.queue, consolidatedScript, true);
    }
    if (migration.removed && !hasConsumer(migration.queue, migration.retiredScript)) {
      try { restoreRetiredConsumer(migration); } catch (rollbackError) {
        console.error(`Failed to restore ${migration.retiredScript}: ${rollbackError.message}`);
      }
    }
    if (migration.paused) {
      try { runWrangler(['queues', 'resume-delivery', migration.queue]); } catch (resumeError) {
        console.error(`Failed to resume ${migration.queue}: ${resumeError.message}`);
      }
    }
  }
  throw error;
} finally {
  deploy.cleanup();
}

for (const retiredScript of [...new Set(migrationSpecs.map(({ retiredScript }) => retiredScript))]) {
  await deleteRetiredWorker(retiredScript);
}
console.log(JSON.stringify({
  event: 'minute_enrichment_worker_consolidation_completed',
  script: consolidatedScript,
  queues: [minuteQueue, ...migrationSpecs.map(({ queue }) => queue)],
  retired_scripts: [...new Set(migrationSpecs.map(({ retiredScript }) => retiredScript))],
  pages_response_kv_namespace: deploy.namespace.id,
}));
