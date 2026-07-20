import {
  consumerList,
  pauseQueue,
  removeConsumer,
  restoreConsumer,
  resumeQueue,
  runWrangler,
} from './monitor-cutover-queues.mjs';

const queue = 'stationhead-comments';
const consolidatedScript = 'sh-buddies-ingest';
const retiredScript = 'sh-buddies-comments';
const deadLetterQueue = 'stationhead-comments-dlq';

function hasConsumer(output, scriptName) {
  return output.includes(scriptName);
}

function currentConsumers() {
  return consumerList(queue);
}

function assertConsumer(output, scriptName, state) {
  if (!hasConsumer(output, scriptName)) {
    throw new Error(`${state} consumer missing for ${queue}: ${scriptName}`);
  }
}

const before = currentConsumers();
const retiredBefore = hasConsumer(before, retiredScript);
const consolidatedBefore = hasConsumer(before, consolidatedScript);
let paused = false;
let retiredRemoved = false;

try {
  runWrangler(['deploy', '--config', 'wrangler.ingest.jsonc']);
  assertConsumer(currentConsumers(), consolidatedScript, 'consolidated ingest');

  if (retiredBefore) {
    pauseQueue(queue);
    paused = true;
    removeConsumer(queue, retiredScript);
    retiredRemoved = true;
    const after = currentConsumers();
    assertConsumer(after, consolidatedScript, 'consolidated ingest');
    if (hasConsumer(after, retiredScript)) {
      throw new Error(`retired comments consumer still attached: ${retiredScript}`);
    }
  }

  if (paused) {
    resumeQueue(queue);
    paused = false;
  }
  console.log(JSON.stringify({
    event: 'comments_worker_consolidation_completed',
    queue,
    consolidated_script: consolidatedScript,
    retired_script: retiredScript,
    retired_consumer_removed: retiredRemoved,
  }));
} catch (error) {
  if (retiredRemoved && !hasConsumer(currentConsumers(), retiredScript)) {
    try {
      restoreConsumer({ queue, oldScript: retiredScript, deadLetterQueue });
    } catch (restoreError) {
      console.error(`Failed to restore ${retiredScript}: ${restoreError.message}`);
    }
  }
  if (!consolidatedBefore && hasConsumer(currentConsumers(), consolidatedScript)) {
    removeConsumer(queue, consolidatedScript, { allowFailure: true });
  }
  if (paused) {
    try { resumeQueue(queue); } catch (resumeError) {
      console.error(`Failed to resume ${queue}: ${resumeError.message}`);
    }
  }
  throw error;
}
