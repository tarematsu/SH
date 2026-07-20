import { spawnSync } from 'node:child_process';

export const CONSOLIDATED_SCRIPT = 'sh-monitor-other';
export const COLLECTOR_SCRIPT = 'sh-buddies-monitor';
export const MIGRATIONS = Object.freeze([
  Object.freeze({
    queue: 'stationhead-buddy-playback',
    oldScript: 'sh-buddy-playback',
    deadLetterQueue: 'stationhead-buddy-playback-dlq',
  }),
  Object.freeze({
    queue: 'stationhead-host-monitor',
    oldScript: 'sh-host-monitor',
    deadLetterQueue: 'stationhead-host-monitor-dlq',
  }),
]);

export function runWrangler(args, { capture = false, allowFailure = false } = {}) {
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

export function consumerList(queue) {
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

export function hasConsumer(queue, scriptName) {
  return consumerList(queue).includes(scriptName);
}

export function assertConsolidatedConsumers() {
  for (const item of MIGRATIONS) {
    const output = consumerList(item.queue);
    if (!output.includes(CONSOLIDATED_SCRIPT)) {
      throw new Error(`consolidated monitor consumer missing for ${item.queue}`);
    }
    if (output.includes(item.oldScript)) {
      throw new Error(`retired monitor consumer still attached: ${item.oldScript}`);
    }
  }
}

export function assertConsolidatedConsumersPresent() {
  for (const item of MIGRATIONS) {
    if (!consumerList(item.queue).includes(CONSOLIDATED_SCRIPT)) {
      throw new Error(`consolidated monitor consumer missing for ${item.queue}`);
    }
  }
}

export function pauseQueue(queue) {
  runWrangler(['queues', 'pause-delivery', queue]);
}

export function resumeQueue(queue) {
  runWrangler(['queues', 'resume-delivery', queue]);
}

export function removeConsumer(queue, scriptName, { allowFailure = false } = {}) {
  runWrangler(
    ['queues', 'consumer', 'worker', 'remove', queue, scriptName],
    { allowFailure },
  );
}

export function restoreConsumer(item) {
  runWrangler([
    'queues', 'consumer', 'worker', 'add', item.queue, item.oldScript,
    '--batch-size', '1',
    '--batch-timeout', '1',
    '--message-retries', '8',
    '--dead-letter-queue', item.deadLetterQueue,
    '--max-concurrency', '1',
  ]);
}
