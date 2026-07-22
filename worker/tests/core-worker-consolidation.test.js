import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import coreWorker, {
  runCoreFetch,
  runCoreQueue,
  runCoreScheduled,
} from '../src/runtime-orchestrator-entry.js';

function batch(queue) {
  return { queue, messages: [{ body: {} }] };
}

test('core Worker exposes fetch, scheduled, and queue surfaces', () => {
  assert.deepEqual(Object.keys(coreWorker).sort(), ['fetch', 'queue', 'scheduled']);
});

test('core queue keeps domain routes in separate invocations', async () => {
  const calls = [];
  const env = { BUDDIES_DB: { name: 'buddies' } };
  const ctx = {};
  const dependencies = {
    runIngestQueue: async (_batch, activeEnv) => calls.push(['ingest', activeEnv.DB]),
    runEnrichmentQueue: async () => calls.push(['enrichment']),
    runPagesQueue: async () => calls.push(['pages']),
    runRuntimeQueue: async () => calls.push(['runtime']),
  };

  await runCoreQueue(batch('stationhead-comments'), env, ctx, dependencies);
  await runCoreQueue(batch('stationhead-minute-enrichment'), env, ctx, dependencies);
  await runCoreQueue(batch('stationhead-read-model'), env, ctx, dependencies);
  await runCoreQueue(batch('stationhead-host-monitor'), env, ctx, dependencies);

  assert.deepEqual(calls, [
    ['ingest', env.BUDDIES_DB],
    ['enrichment'],
    ['pages'],
    ['runtime'],
  ]);
});

test('one cron dispatches runtime and Pages work to separate Queues', async () => {
  const calls = [];
  const controller = { cron: '* * * * *', scheduledTime: 123 };
  const result = await runCoreScheduled(controller, {}, {}, {
    runRuntimeScheduled: async () => { calls.push('runtime'); return ['runtime']; },
    dispatchPagesScheduled: async () => { calls.push('pages'); return { dispatched: true }; },
  });
  assert.deepEqual(calls.sort(), ['pages', 'runtime']);
  assert.deepEqual(result, { runtime: ['runtime'], pages: { dispatched: true } });
});

test('internal Pages fetch is delegated without exposing another Worker', async () => {
  const response = await runCoreFetch(new Request('https://internal.test/'), {}, {}, {
    runPagesFetch: async () => new Response('ok'),
  });
  assert.equal(await response.text(), 'ok');
});

test('runtime config contains all core bindings while retired configs are not deploy scripts', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.runtime.jsonc', import.meta.url), 'utf8'));
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const pagesConfig = JSON.parse(readFileSync(new URL('../../site/wrangler.jsonc', import.meta.url), 'utf8'));
  const consumers = new Set(config.queues.consumers.map(({ queue }) => queue));
  for (const queue of [
    'stationhead-raw-collection',
    'stationhead-comments',
    'stationhead-minute-enrichment',
    'stationhead-track-metadata',
    'stationhead-pages-read-model-publication',
    'stationhead-host-monitor',
    'stationhead-minute-live-derive',
  ]) {
    assert.equal(consumers.has(queue), true, queue);
  }
  assert.equal('deploy:ingest' in packageJson.scripts, false);
  assert.equal('deploy:minute-enrichment' in packageJson.scripts, false);
  assert.equal(packageJson.scripts['deploy:runtime'], 'node scripts/deploy-runtime.mjs');
  assert.deepEqual(pagesConfig.services, [{
    binding: 'PAGES_READ_MODEL_SERVICE',
    service: 'sh-runtime-orchestrator',
  }]);
});
