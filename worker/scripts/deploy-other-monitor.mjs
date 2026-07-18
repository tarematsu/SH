import { spawnSync } from 'node:child_process';

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

function hasConsumer(queue, scriptName) {
  const result = runWrangler(
    ['queues', 'consumer', 'worker', 'list', queue, '--json'],
    { capture: true, allowFailure: true },
  );
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return result.status === 0 && output.includes(scriptName);
}

function pause(queue) {
  runWrangler(['queues', 'pause-delivery', queue]);
}

function resume(queue) {
  runWrangler(['queues', 'resume-delivery', queue]);
}

function removeOldConsumer(item) {
  runWrangler(
    ['queues', 'consumer', 'worker', 'remove', item.queue, item.oldScript],
    { allowFailure: false },
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

async function deleteOldWorker(scriptName) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN
    || process.env.CLOUDFLARE_BUILDS_API_TOKEN
    || process.env.CF_API_TOKEN;
  if (!accountId || !token) {
    console.warn(`Skipping retired Worker deletion for ${scriptName}: account credentials are unavailable`);
    return;
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}?force=true`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await response.json().catch(() => null);
  const notFound = response.status === 404 || body?.errors?.some((error) => /not found/i.test(String(error?.message || '')));
  if (!response.ok && !notFound) {
    console.warn(`Retired Worker ${scriptName} was not deleted: HTTP ${response.status}`);
  }
}

const activeMigrations = migrations.filter((item) => hasConsumer(item.queue, item.oldScript));
const paused = [];
const removed = [];

try {
  for (const item of activeMigrations) {
    pause(item.queue);
    paused.push(item);
    removeOldConsumer(item);
    removed.push(item);
  }

  runWrangler(['deploy', '--config', 'wrangler.other.jsonc']);

  for (const item of paused) resume(item.queue);
  paused.length = 0;

  for (const item of removed) await deleteOldWorker(item.oldScript);
} catch (error) {
  for (const item of removed.toReversed()) {
    try {
      restoreOldConsumer(item);
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
