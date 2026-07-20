import {
  consumerList,
  pauseQueue,
  removeConsumer,
  restoreConsumer,
  resumeQueue,
  runWrangler,
} from './monitor-cutover-queues.mjs';

const consolidatedScript = 'sh-buddies-ingest';
const MIGRATIONS = Object.freeze([
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

function hasConsumer(output, scriptName) {
  return output.includes(scriptName);
}

function assertConsumer(output, queue, scriptName, state) {
  if (!hasConsumer(output, scriptName)) {
    throw new Error(`${state} consumer missing for ${queue}: ${scriptName}`);
  }
}

const before = new Map(MIGRATIONS.map((migration) => [migration.queue, consumerList(migration.queue)]));
const retiredBefore = new Set(MIGRATIONS
  .filter((migration) => hasConsumer(before.get(migration.queue), migration.oldScript))
  .map((migration) => migration.queue));
const consolidatedBefore = new Set(MIGRATIONS
  .filter((migration) => hasConsumer(before.get(migration.queue), consolidatedScript))
  .map((migration) => migration.queue));
const pausedQueues = new Set();
const retiredRemoved = new Set();

try {
  // A Queue accepts only one consumer for this cutover path. Remove the
  // retired consumer while delivery is paused before Wrangler registers the
  // consolidated consumer, then restore it if deployment fails.
  for (const migration of MIGRATIONS) {
    if (!retiredBefore.has(migration.queue)) continue;
    pauseQueue(migration.queue);
    pausedQueues.add(migration.queue);
    removeConsumer(migration.queue, migration.oldScript);
    retiredRemoved.add(migration.queue);
  }

  runWrangler(['deploy', '--config', 'wrangler.ingest.jsonc']);
  for (const migration of MIGRATIONS) {
    assertConsumer(
      consumerList(migration.queue),
      migration.queue,
      consolidatedScript,
      'consolidated ingest',
    );
  }

  for (const migration of MIGRATIONS) {
    const after = consumerList(migration.queue);
    assertConsumer(after, migration.queue, consolidatedScript, 'consolidated ingest');
    if (hasConsumer(after, migration.oldScript)) {
      throw new Error(`retired consumer still attached: ${migration.oldScript}`);
    }
  }

  for (const queue of pausedQueues) {
    resumeQueue(queue);
  }
  pausedQueues.clear();
  console.log(JSON.stringify({
    event: 'ingest_worker_consolidation_completed',
    queues: MIGRATIONS.map(({ queue }) => queue),
    consolidated_script: consolidatedScript,
    retired_consumers_removed: [...retiredRemoved],
  }));
} catch (error) {
  for (const migration of MIGRATIONS) {
    if (!retiredRemoved.has(migration.queue)) continue;
    if (!hasConsumer(consumerList(migration.queue), migration.oldScript)) {
      try {
        restoreConsumer(migration);
      } catch (restoreError) {
        console.error(`Failed to restore ${migration.oldScript}: ${restoreError.message}`);
      }
    }
  }
  for (const migration of MIGRATIONS) {
    if (!consolidatedBefore.has(migration.queue)
        && hasConsumer(consumerList(migration.queue), consolidatedScript)) {
      removeConsumer(migration.queue, consolidatedScript, { allowFailure: true });
    }
  }
  for (const queue of pausedQueues) {
    try { resumeQueue(queue); } catch (resumeError) {
      console.error(`Failed to resume ${queue}: ${resumeError.message}`);
    }
  }
  throw error;
}
