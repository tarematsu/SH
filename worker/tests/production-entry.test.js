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

test('buddies worker exposes no HTTP control or health endpoints', async () => {
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

test('buddies Wrangler configuration contains only primary-collector settings and bindings', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.main, 'src/production-entry.js');
  assert.deepEqual(config.triggers?.crons, ['* * * * *']);
  assert.deepEqual(config.d1_databases.map(({ binding }) => binding), ['DB']);
  assert.equal(config.d1_databases[0].database_name, 'stationhead-buddies');
  assert.equal(config.d1_databases[0].database_id, 'f361aae0-05f0-42bc-8784-77100e80133d');
  assert.deepEqual(config.queues?.producers, [{
    binding: 'MINUTE_FACT_QUEUE',
    queue: 'stationhead-buddies-facts',
  }]);

  const names = Object.keys(config.vars || {});
  for (const prefix of ['BUDDY_PLAYBACK_', 'HOST_', 'SOLO_', 'OFFICIAL_NEWS_', 'DERIVE_', 'HEALTH_ALERT_']) {
    assert.equal(names.some((name) => name.startsWith(prefix)), false, prefix);
  }
  assert.equal('DATA_MAINTENANCE_ENABLED' in config.vars, false);
});
