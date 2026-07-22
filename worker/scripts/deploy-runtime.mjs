import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  hasConsumer,
  pauseQueue,
  removeConsumer,
  restoreConsumer,
  resumeQueue,
  runWrangler,
} from './cloudflare-queues.mjs';
import {
  RETIRED_WORKER_NAMES,
  pruneRetiredWorkers,
} from './cloudflare-workers.mjs';
import { preparePagesReadModelDeployConfig } from './pages-response-kv-namespace.mjs';
import {
  ensureRuntimeAnalyticsResources,
  runtimeConfigWithAnalyticsStream,
} from './provision-runtime-analytics-pipeline.mjs';

const workerRoot = fileURLToPath(new URL('..', import.meta.url));
const configName = 'wrangler.runtime.jsonc';
const config = JSON.parse(readFileSync(new URL(`../${configName}`, import.meta.url), 'utf8'));
const runtimeScript = config.name;
const DEFERRED_RETIREMENT_WORKERS = new Set(['sh-minute-enrichment']);
const previousScriptByQueue = new Map([
  ['stationhead-raw-collection', 'sh-buddies-ingest'],
  ['stationhead-ingest-finalize', 'sh-buddies-ingest'],
  ['stationhead-comments', 'sh-buddies-ingest'],
  ['stationhead-buddies-persist', 'sh-buddies-ingest'],
  ['stationhead-minute-enrichment', 'sh-minute-enrichment'],
  ['stationhead-track-metadata', 'sh-minute-enrichment'],
  ['stationhead-pages-read-model-publication', 'sh-minute-enrichment'],
  ['stationhead-read-model', 'sh-minute-enrichment'],
]);
const migrations = Object.freeze(config.queues.consumers.map((consumer) => Object.freeze({
  queue: consumer.queue,
  oldScript: previousScriptByQueue.get(consumer.queue) || null,
  deadLetterQueue: consumer.dead_letter_queue,
  batchSize: consumer.max_batch_size,
  maxConcurrency: consumer.max_concurrency,
})));

const deploy = await preparePagesReadModelDeployConfig(workerRoot, {
  sourcePath: `${workerRoot}/${configName}`,
  temporaryPath: `${workerRoot}/.wrangler.runtime.deploy-${process.pid}.jsonc`,
});
const paused = new Set();
const removed = new Set();
let previousConsumers = new Set();
let runtimeConsumers = new Set();
let analyticsResources = null;

try {
  // Provision the Pipelines stream, R2 Parquet sink, and SQL pipeline before any
  // Queue consumer is paused. A missing Pipelines permission therefore fails
  // closed without disrupting the production ingestion topology.
  analyticsResources = ensureRuntimeAnalyticsResources();
  writeFileSync(
    deploy.configPath,
    runtimeConfigWithAnalyticsStream(
      readFileSync(deploy.configPath, 'utf8'),
      analyticsResources.stream.id,
    ),
    'utf8',
  );

  previousConsumers = new Set(
    migrations
      .filter(({ queue, oldScript }) => oldScript && hasConsumer(queue, oldScript))
      .map(({ queue }) => queue),
  );
  runtimeConsumers = new Set(
    migrations.filter(({ queue }) => hasConsumer(queue, runtimeScript)).map(({ queue }) => queue),
  );

  for (const migration of migrations) {
    if (!migration.oldScript || !previousConsumers.has(migration.queue)) continue;
    pauseQueue(migration.queue);
    paused.add(migration.queue);
    removeConsumer(migration.queue, migration.oldScript);
    removed.add(migration.queue);
  }

  runWrangler(['deploy', '--config', deploy.configPath]);

  for (const { queue, oldScript } of migrations) {
    if (!hasConsumer(queue, runtimeScript)) {
      throw new Error(`runtime orchestrator consumer missing for ${queue}`);
    }
    if (oldScript && hasConsumer(queue, oldScript)) {
      throw new Error(`retired core consumer still attached: ${oldScript} on ${queue}`);
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
    if (migration.oldScript
        && removed.has(migration.queue)
        && !hasConsumer(migration.queue, migration.oldScript)) {
      try { restoreConsumer(migration); }
      catch (rollbackError) {
        console.error(`Failed to restore ${migration.oldScript} on ${migration.queue}: ${rollbackError.message}`);
      }
    }
  }
  for (const queue of paused) {
    try { resumeQueue(queue); }
    catch (resumeError) { console.error(`Failed to resume ${queue}: ${resumeError.message}`); }
  }
  throw error;
} finally {
  deploy.cleanup();
}

// `sh-minute-enrichment` remains alive until Pages successfully switches its
// Service Binding to the runtime Worker. Deleting it here would make a later
// Pages deployment failure turn into a public API outage.
const immediatelyRetiredWorkers = RETIRED_WORKER_NAMES.filter(
  (name) => !DEFERRED_RETIREMENT_WORKERS.has(name),
);
await pruneRetiredWorkers(immediatelyRetiredWorkers);

console.log(JSON.stringify({
  event: 'core_runtime_worker_deployed',
  script: runtimeScript,
  retired_scripts: immediatelyRetiredWorkers,
  deferred_retired_scripts: [...DEFERRED_RETIREMENT_WORKERS],
  queues: migrations.map(({ queue }) => queue),
  pages_response_kv_namespace: deploy.namespace.id,
  runtime_analytics_stream: analyticsResources?.stream || null,
  runtime_analytics_sink: analyticsResources?.sink || null,
  runtime_analytics_pipeline: analyticsResources?.pipeline || null,
}));
