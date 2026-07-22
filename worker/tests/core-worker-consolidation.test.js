import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import coreWorker, {
  RuntimeCoordinator,
  lightweightLiveBudgetKind,
  lightweightLiveCompleteBatch,
  runCoreFetch,
  runCoreQueue,
  runCoreScheduled,
  runCoordinatedScheduled,
} from '../src/runtime-orchestrator-entry.js';

function batch(queue, body = {}) {
  return { queue, messages: [{ body }] };
}

function liveCompleteBody(jobKind = 'live') {
  return {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'complete',
    job: { id: 42, job_kind: jobKind },
  };
}

const LIVE_ENV = Object.freeze({
  LIVE_REVISION_MATERIALIZATION_ENABLED: false,
  HISTORICAL_REBUILD_ENABLED: true,
});

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

test('all budgeted live stages bypass the common runtime and derive graphs', async () => {
  const cases = [
    ['trigger', { message_type: 'minute-fact-derive', message_version: 1 }],
    ['revision', {
      message_type: 'minute-fact-derive-stage',
      message_version: 1,
      stage: 'revision-materialize',
      revision: { revision_id: 7, sparse: true, rebuild: false },
    }],
    ['write', {
      message_type: 'minute-fact-derive-stage',
      message_version: 1,
      stage: 'budget-live-write',
      job: { id: 42, job_kind: 'live' },
    }],
    ['complete', liveCompleteBody()],
  ];
  for (const [kind, body] of cases) {
    assert.equal(
      lightweightLiveBudgetKind(batch('stationhead-minute-live-derive', body), LIVE_ENV),
      kind,
    );
  }
  assert.equal(lightweightLiveCompleteBatch(
    batch('stationhead-minute-live-derive', liveCompleteBody()),
    LIVE_ENV,
  ), true);
  assert.equal(lightweightLiveBudgetKind(
    batch('stationhead-minute-live-derive', liveCompleteBody('rebuild')),
    LIVE_ENV,
  ), null);

  const calls = [];
  const handlers = {
    async runLiveTriggerQueue() { calls.push('trigger'); },
    async runLiveRevisionQueue() { calls.push('revision'); },
    async runLiveWriteQueue() { calls.push('write'); },
    async runLiveCompleteQueue() { calls.push('complete'); },
    async runRuntimeQueue() { calls.push('runtime'); },
  };
  for (const [_kind, body] of cases) {
    await runCoreQueue(batch('stationhead-minute-live-derive', body), LIVE_ENV, {}, handlers);
  }
  assert.deepEqual(calls, ['trigger', 'revision', 'write', 'complete']);
});

test('one Durable Object tick runs routine Pages work without a per-minute Queue hop', async () => {
  const calls = [];
  const controller = { cron: '* * * * *', scheduledTime: 123 };
  const result = await runCoreScheduled(controller, {}, {}, {
    runRuntimeScheduled: async () => { calls.push('runtime'); return ['runtime']; },
    runPagesScheduled: async () => { calls.push('pages'); return { inline: true }; },
  });
  assert.deepEqual(calls.sort(), ['pages', 'runtime']);
  assert.deepEqual(result, { runtime: ['runtime'], pages: { inline: true } });
});

test('scheduled work claims one short Durable Object ticket before running outside it', async () => {
  const calls = [];
  const controller = { cron: '* * * * *', scheduledTime: 123 };
  const coordinated = await runCoordinatedScheduled(controller, {}, {}, {
    stub: { async claim(value) { calls.push(['do', value]); return { claimed: true }; } },
    runDirect: async (_controller, env) => {
      calls.push(['direct', env.PRIMARY_RUN_LOCK_ENABLED]);
      return 'direct';
    },
  });
  assert.equal(coordinated, 'direct');
  assert.deepEqual(calls, [['do', controller], ['direct', false]]);

  const duplicate = await runCoordinatedScheduled(controller, {}, {}, {
    stub: { async claim() { return { claimed: false }; } },
    runDirect: async () => assert.fail('duplicate tick must not run'),
  });
  assert.deepEqual(duplicate, { skipped: true, reason: 'runtime-coordinator-duplicate' });

  const fallback = await runCoordinatedScheduled(controller, {}, {}, {
    stub: { async claim() { throw new Error('temporary DO failure'); } },
    runDirect: async () => 'direct',
  });
  assert.deepEqual(fallback, { skipped: true, reason: 'runtime-coordinator-error' });
});

test('RuntimeCoordinator persists one overwritten ticket and rejects a duplicate tick', async () => {
  const rows = new Map();
  const state = {
    storage: {
      async get(key) { return rows.get(key); },
      async put(key, value) { rows.set(key, value); },
    },
  };
  const coordinator = new RuntimeCoordinator(state);
  const controller = { cron: '* * * * *', scheduledTime: 123 };
  assert.deepEqual(await coordinator.claim(controller), { claimed: true });
  assert.deepEqual(await coordinator.claim(controller), {
    claimed: false,
    reason: 'runtime-coordinator-duplicate',
  });
  assert.equal(rows.size, 1);
  assert.deepEqual(await coordinator.claim({ ...controller, scheduledTime: 124 }), { claimed: true });
  assert.equal(rows.size, 1);

  const config = JSON.parse(readFileSync(new URL('../wrangler.runtime.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.durable_objects.bindings, [{
    name: 'RUNTIME_COORDINATOR',
    class_name: 'RuntimeCoordinator',
  }]);
  assert.deepEqual(config.migrations.at(-1), {
    tag: 'runtime-coordinator-v1',
    new_sqlite_classes: ['RuntimeCoordinator'],
  });
});

test('internal Pages fetch is delegated without exposing another Worker', async () => {
  const response = await runCoreFetch(new Request('https://internal.test/'), {}, {}, {
    runPagesFetch: async () => new Response('ok'),
  });
  assert.equal(await response.text(), 'ok');
});

test('runtime config contains all core bindings while only two Workers stay active', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.runtime.jsonc', import.meta.url), 'utf8'));
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const pagesConfig = JSON.parse(readFileSync(new URL('../../site/wrangler.jsonc', import.meta.url), 'utf8'));
  const workers = readFileSync(new URL('../scripts/cloudflare-workers.mjs', import.meta.url), 'utf8');
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
  const activeBlock = workers.slice(
    workers.indexOf('ACTIVE_WORKER_NAMES'),
    workers.indexOf('RETIRED_WORKER_NAMES'),
  );
  assert.deepEqual(
    [...activeBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]),
    ['sh-sakurazaka46jp', 'sh-runtime-orchestrator'],
  );
});
