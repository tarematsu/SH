import { fileURLToPath } from 'node:url';

import {
  hasConsumer,
  pauseQueue,
  removeConsumer,
  restoreConsumer,
  resumeQueue,
  runWrangler,
} from './cloudflare-queues.mjs';
import { deleteWorker } from './cloudflare-workers.mjs';
import { preparePagesReadModelDeployConfig } from './pages-response-kv-namespace.mjs';

const workerRoot = fileURLToPath(new URL('..', import.meta.url));
const minuteQueue = 'stationhead-minute-enrichment';
const consolidatedScript = 'sh-minute-enrichment';
const migrationSpecs = Object.freeze([
  Object.freeze({
    queue: 'stationhead-track-metadata',
    deadLetterQueue: 'stationhead-track-metadata-dlq',
    retiredScript: 'sh-track-metadata',
  }),
  Object.freeze({
    queue: 'stationhead-read-model',
    deadLetterQueue: 'stationhead-read-model-dlq',
    retiredScript: 'sh-pages-read-model',
  }),
  Object.freeze({
    queue: 'stationhead-pages-read-model-publication',
    deadLetterQueue: 'stationhead-pages-read-model-publication-dlq',
    retiredScript: 'sh-pages-read-model',
  }),
]);

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
    pauseQueue(migration.queue);
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
      resumeQueue(migration.queue);
      migration.paused = false;
    }
  }
} catch (error) {
  for (const migration of migrations.toReversed()) {
    if (!migration.consolidatedBefore && hasConsumer(migration.queue, consolidatedScript)) {
      try { removeConsumer(migration.queue, consolidatedScript, { allowFailure: true }); }
      catch (rollbackError) {
        console.error(`Failed to remove ${consolidatedScript}: ${rollbackError.message}`);
      }
    }
    if (migration.removed && !hasConsumer(migration.queue, migration.retiredScript)) {
      try { restoreConsumer(migration); }
      catch (rollbackError) {
        console.error(`Failed to restore ${migration.retiredScript}: ${rollbackError.message}`);
      }
    }
    if (migration.paused) {
      try { resumeQueue(migration.queue); }
      catch (resumeError) {
        console.error(`Failed to resume ${migration.queue}: ${resumeError.message}`);
      }
    }
  }
  throw error;
} finally {
  deploy.cleanup();
}

const retiredScripts = [...new Set(migrationSpecs.map(({ retiredScript }) => retiredScript))];
for (const retiredScript of retiredScripts) await deleteWorker(retiredScript);
console.log(JSON.stringify({
  event: 'minute_enrichment_worker_consolidation_completed',
  script: consolidatedScript,
  queues: [minuteQueue, ...migrationSpecs.map(({ queue }) => queue)],
  retired_scripts: retiredScripts,
  pages_response_kv_namespace: deploy.namespace.id,
}));
