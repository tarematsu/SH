import {
  hasConsumer,
  pauseQueue,
  removeConsumer,
  restoreConsumer,
  resumeQueue,
  runWrangler,
} from './cloudflare-queues.mjs';

const consolidatedScript = 'sh-buddies-ingest';
const migrations = Object.freeze([
  Object.freeze({
    queue: 'stationhead-comments',
    oldScript: 'sh-buddies-comments',
    deadLetterQueue: 'stationhead-comments-dlq',
  }),
  Object.freeze({
    queue: 'stationhead-buddies-persist',
    oldScript: 'sh-buddies-persist',
    deadLetterQueue: 'stationhead-buddies-persist-dlq',
  }),
]);

const retiredBefore = new Set(migrations
  .filter(({ queue, oldScript }) => hasConsumer(queue, oldScript))
  .map(({ queue }) => queue));
const consolidatedBefore = new Set(migrations
  .filter(({ queue }) => hasConsumer(queue, consolidatedScript))
  .map(({ queue }) => queue));
const pausedQueues = new Set();
const retiredRemoved = new Set();

try {
  for (const migration of migrations) {
    if (!retiredBefore.has(migration.queue)) continue;
    pauseQueue(migration.queue);
    pausedQueues.add(migration.queue);
    removeConsumer(migration.queue, migration.oldScript);
    retiredRemoved.add(migration.queue);
  }

  runWrangler(['deploy', '--config', 'wrangler.ingest.jsonc']);
  for (const migration of migrations) {
    if (!hasConsumer(migration.queue, consolidatedScript)) {
      throw new Error(`consolidated ingest consumer missing for ${migration.queue}`);
    }
    if (hasConsumer(migration.queue, migration.oldScript)) {
      throw new Error(`retired consumer still attached: ${migration.oldScript}`);
    }
  }

  for (const queue of pausedQueues) resumeQueue(queue);
  pausedQueues.clear();
  console.log(JSON.stringify({
    event: 'ingest_worker_consolidation_completed',
    queues: migrations.map(({ queue }) => queue),
    consolidated_script: consolidatedScript,
    retired_consumers_removed: [...retiredRemoved],
  }));
} catch (error) {
  for (const migration of migrations.toReversed()) {
    if (retiredRemoved.has(migration.queue)
        && !hasConsumer(migration.queue, migration.oldScript)) {
      try { restoreConsumer(migration); }
      catch (restoreError) {
        console.error(`Failed to restore ${migration.oldScript}: ${restoreError.message}`);
      }
    }
    if (!consolidatedBefore.has(migration.queue)
        && hasConsumer(migration.queue, consolidatedScript)) {
      try { removeConsumer(migration.queue, consolidatedScript, { allowFailure: true }); }
      catch (rollbackError) {
        console.error(`Failed to remove ${consolidatedScript}: ${rollbackError.message}`);
      }
    }
  }
  for (const queue of pausedQueues) {
    try { resumeQueue(queue); }
    catch (resumeError) { console.error(`Failed to resume ${queue}: ${resumeError.message}`); }
  }
  throw error;
}
