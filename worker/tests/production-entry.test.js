import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runProductionScheduled } from '../src/production-entry.js';

test('production cron schedules buddy46 before delegating to the resilient collector', async () => {
  const calls = [];
  const controller = { scheduledTime: 300_000, cron: '* * * * *' };
  const env = { marker: true };
  const ctx = { waitUntil() {} };

  const result = await runProductionScheduled(controller, env, ctx, {
    scheduleBuddyPlayback(receivedEnv, receivedCtx, scheduledAt) {
      calls.push(['buddy', receivedEnv, receivedCtx, scheduledAt]);
    },
    app: {
      async scheduled(receivedController, receivedEnv, receivedCtx) {
        calls.push(['primary', receivedController, receivedEnv, receivedCtx]);
        return 'done';
      },
    },
  });

  assert.equal(result, 'done');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['buddy', env, ctx, 300_000]);
  assert.deepEqual(calls[1], ['primary', controller, env, ctx]);
});

test('Wrangler deploys the production cron wrapper', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.main, 'src/production-entry.js');
  assert.deepEqual(config.triggers?.crons, ['* * * * *']);
});
