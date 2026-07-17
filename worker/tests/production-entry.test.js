import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import productionApp, {
  runProductionCron,
  runProductionScheduled,
} from '../src/production-entry.js';

 test('production cron delegates only to the primary collection app', async () => {
  const calls = [];
  const controller = { scheduledTime: 300_000, cron: '* * * * *' };
  const env = { marker: true };
  const ctx = {};
  const result = await runProductionScheduled(controller, env, ctx, {
    app: {
      async scheduled(receivedController, receivedEnv, receivedCtx) {
        calls.push([receivedController, receivedEnv, receivedCtx]);
        return 'primary-done';
      },
    },
  });

  assert.equal(result, 'primary-done');
  assert.deepEqual(calls, [[controller, env, ctx]]);
  assert.equal(await runProductionCron(controller, env, ctx, {
    app: { scheduled: async () => 'cron-done' },
  }), 'cron-done');
});

test('legacy production entry exposes no HTTP control or health endpoints', async () => {
  const requests = [
    new Request('https://buddies.test/'),
    new Request('https://buddies.test/health'),
    new Request('https://buddies.test/run', { method: 'POST' }),
    new Request('https://buddies.test/refresh-auth', { method: 'POST' }),
    new Request('https://buddies.test/coordination/lease'),
    new Request('https://buddies.test/ingest/email-recap', { method: 'POST' }),
  ];

  for (const request of requests) {
    const response = await productionApp.fetch(request, {}, {});
    assert.equal(response.status, 404, `${request.method} ${new URL(request.url).pathname}`);
  }
  assert.equal((await productionApp.fetch(new Request('https://buddies.test/favicon.ico'), {}, {})).status, 204);
});

test('buddies Wrangler configuration owns collection and compact queue preparation only', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../src/raw-collector-entry.js', import.meta.url), 'utf8');
  assert.equal(config.main, 'src/raw-collector-entry.js');
  assert.deepEqual(config.triggers?.crons, ['* * * * *']);
  assert.deepEqual(config.d1_databases.map(({ binding }) => binding), ['DB']);
  assert.equal(config.d1_databases[0].database_name, 'stationhead-buddies');
  assert.deepEqual(config.queues?.producers, [{
    binding: 'RAW_COLLECTION_QUEUE',
    queue: 'stationhead-raw-collection',
  }]);
  assert.match(source, /JSON\.parse/);
  assert.match(source, /normalizeSnapshot/);
  assert.match(source, /extractQueue/);
  assert.doesNotMatch(source, /response\.json|readModelPresentation|handoffMinuteFactJob/);

  const names = Object.keys(config.vars || {});
  for (const prefix of ['BUDDY_PLAYBACK_', 'HOST_', 'SOLO_', 'OFFICIAL_NEWS_', 'DERIVE_', 'HEALTH_ALERT_']) {
    assert.equal(names.some((name) => name.startsWith(prefix)), false, prefix);
  }
  assert.equal('DATA_MAINTENANCE_ENABLED' in config.vars, false);
});