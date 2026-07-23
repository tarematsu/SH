import { readFileSync } from 'node:fs';

import {
  hasConsumer,
  pauseQueue,
  removeConsumer,
  restoreConsumer,
  resumeQueue,
  runWrangler,
} from './cloudflare-queues.mjs';

const configName = 'wrangler.buddies-collector.jsonc';
const config = JSON.parse(readFileSync(new URL(`../${configName}`, import.meta.url), 'utf8'));
const collectorScript = config.name;
const previousScript = 'sh-runtime-orchestrator';
const migrations = Object.freeze(config.queues.consumers.map((consumer) => Object.freeze({
  queue: consumer.queue,
  oldScript: previousScript,
  deadLetterQueue: consumer.dead_letter_queue,
  batchSize: consumer.max_batch_size,
  maxConcurrency: consumer.max_concurrency,
})));

const paused = new Set();
const removed = new Set();
let previousConsumers = new Set();
let collectorConsumers = new Set();

try {
  previousConsumers = new Set(
    migrations
      .filter(({ queue }) => hasConsumer(queue, previousScript))
      .map(({ queue }) => queue),
  );
  collectorConsumers = new Set(
    migrations
      .filter(({ queue }) => hasConsumer(queue, collectorScript))
      .map(({ queue }) => queue),
  );

  for (const migration of migrations) {
    if (!previousConsumers.has(migration.queue)) continue;
    pauseQueue(migration.queue);
    paused.add(migration.queue);
    removeConsumer(migration.queue, previousScript);
    removed.add(migration.queue);
  }

  runWrangler(['deploy', '--config', configName]);

  for (const { queue } of migrations) {
    if (!hasConsumer(queue, collectorScript)) {
      throw new Error(`buddies collector consumer missing for ${queue}`);
    }
    if (hasConsumer(queue, previousScript)) {
      throw new Error(`runtime still owns buddies collector queue ${queue}`);
    }
  }

  for (const queue of paused) resumeQueue(queue);
  paused.clear();
} catch (error) {
  for (const migration of migrations.toReversed()) {
    if (!collectorConsumers.has(migration.queue) && hasConsumer(migration.queue, collectorScript)) {
      try { removeConsumer(migration.queue, collectorScript, { allowFailure: true }); }
      catch (rollbackError) {
        console.error(`Failed to remove ${collectorScript} from ${migration.queue}: ${rollbackError.message}`);
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

console.log(JSON.stringify({
  event: 'buddies_collector_worker_deployed',
  script: collectorScript,
  previous_script: previousScript,
  queues: migrations.map(({ queue }) => queue),
}));
