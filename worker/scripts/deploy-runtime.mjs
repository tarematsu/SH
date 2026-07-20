import { readFileSync } from 'node:fs';

import {
  hasConsumer,
  pauseQueue,
  removeConsumer,
  restoreConsumer,
  resumeQueue,
  runWrangler,
} from './cloudflare-queues.mjs';
import { pruneRetiredWorkers } from './cloudflare-workers.mjs';

const configName = 'wrangler.runtime.jsonc';
const config = JSON.parse(readFileSync(new URL(`../${configName}`, import.meta.url), 'utf8'));
const runtimeScript = config.name;
const previousScript = 'sh-monitor-other';
const migrations = Object.freeze(config.queues.consumers.map((consumer) => Object.freeze({
  queue: consumer.queue,
  oldScript: previousScript,
  deadLetterQueue: consumer.dead_letter_queue,
  batchSize: consumer.max_batch_size,
  maxConcurrency: consumer.max_concurrency,
})));

const previousConsumers = new Set(
  migrations.filter(({ queue }) => hasConsumer(queue, previousScript)).map(({ queue }) => queue),
);
const runtimeConsumers = new Set(
  migrations.filter(({ queue }) => hasConsumer(queue, runtimeScript)).map(({ queue }) => queue),
);
const paused = new Set();
const removed = new Set();

try {
  for (const migration of migrations) {
    if (!previousConsumers.has(migration.queue)) continue;
    pauseQueue(migration.queue);
    paused.add(migration.queue);
    removeConsumer(migration.queue, previousScript);
    removed.add(migration.queue);
  }

  runWrangler(['deploy', '--config', configName]);

  for (const { queue } of migrations) {
    if (!hasConsumer(queue, runtimeScript)) {
      throw new Error(`runtime orchestrator consumer missing for ${queue}`);
    }
    if (hasConsumer(queue, previousScript)) {
      throw new Error(`retired runtime consumer still attached for ${queue}`);
    }
  }

  for (const queue of paused) resumeQueue(queue);
  paused.clear();
} catch (error) {
  for (const migration of migrations.toReversed()) {
    if (!runtimeConsumers.has(migration.queue) && hasConsumer(migration.queue, runtimeScript)) {
      try { removeConsumer(migration.queue, runtimeScript, { allowFailure: true }); }
      catch (rollbackError) {
        console.error(`Failed to remove ${runtimeScript} from ${migration.queue}: ${rollbackError.message}`);
      }
    }
    if (removed.has(migration.queue) && !hasConsumer(migration.queue, previousScript)) {
      try { restoreConsumer(migration); }
      catch (rollbackError) {
        console.error(`Failed to restore ${previousScript} on ${migration.queue}: ${rollbackError.message}`);
      }
    }
  }
  for (const queue of paused) {
    try { resumeQueue(queue); }
    catch (resumeError) { console.error(`Failed to resume ${queue}: ${resumeError.message}`); }
  }
  throw error;
}

// Worker retirement is intentionally after the reversible Queue cutover. A
// deletion failure leaves the new runtime active and is safe to retry.
await pruneRetiredWorkers();

console.log(JSON.stringify({
  event: 'runtime_orchestrator_deployed',
  script: runtimeScript,
  retired_script: previousScript,
  queues: migrations.map(({ queue }) => queue),
}));
