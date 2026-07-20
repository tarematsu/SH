import { spawnSync } from 'node:child_process';

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

export function restoreConsumer({
  queue,
  oldScript,
  retiredScript,
  batchSize = 1,
  maxConcurrency = 1,
  deadLetterQueue,
}) {
  const scriptName = oldScript || retiredScript;
  if (!scriptName) throw new Error(`consumer script is missing for ${queue}`);
  runWrangler([
    'queues', 'consumer', 'worker', 'add', queue, scriptName,
    '--batch-size', String(batchSize),
    '--batch-timeout', '1',
    '--message-retries', '8',
    '--dead-letter-queue', deadLetterQueue,
    '--max-concurrency', String(maxConcurrency),
  ]);
}
