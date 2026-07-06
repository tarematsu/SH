import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { runProductionScheduled } from '../src/production-entry.js';

test('production cron runs primary before buddy46 collection', async () => {
  const calls = [];
  const waitUntilTasks = [];
  const controller = { scheduledTime: 300_000, cron: '* * * * *' };
  const env = { marker: true };
  const ctx = { waitUntil(task) { waitUntilTasks.push(task); } };

  const result = await runProductionScheduled(controller, env, ctx, {
    scheduleBuddyPlayback(receivedEnv, receivedCtx, scheduledAt) {
      calls.push(['buddy', receivedEnv, receivedCtx, scheduledAt]);
      return Promise.resolve('buddy-done');
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
  assert.deepEqual(calls[0], ['primary', controller, env, ctx]);
  assert.deepEqual(calls[1], ['buddy', env, ctx, 300_000]);
  assert.equal(waitUntilTasks.length, 1);
  assert.equal(await waitUntilTasks[0], 'buddy-done');
});

test('production cron attaches buddy46 collection to waitUntil after primary completes', async () => {
  const calls = [];
  const waitUntilTasks = [];
  let releaseBuddy;
  const buddyGate = new Promise((resolve) => { releaseBuddy = resolve; });
  const run = runProductionScheduled(
    { scheduledTime: 300_000 },
    {},
    { waitUntil(task) { waitUntilTasks.push(task); } },
    {
      scheduleBuddyPlayback() {
        calls.push('buddy-start');
        return buddyGate.then(() => calls.push('buddy-done'));
      },
      app: {
        async scheduled() {
          calls.push('primary-done');
          return 'done';
        },
      },
    },
  );

  await Promise.resolve();
  assert.deepEqual(calls, ['primary-done', 'buddy-start']);
  assert.equal(await run, 'done');
  assert.equal(waitUntilTasks.length, 1);
  assert.deepEqual(calls, ['primary-done', 'buddy-start']);
  releaseBuddy();
  await waitUntilTasks[0];
  assert.deepEqual(calls, ['primary-done', 'buddy-start', 'buddy-done']);
});

test('Wrangler deploys the production cron wrapper', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.main, 'src/production-entry.js');
  assert.deepEqual(config.triggers?.crons, ['* * * * *']);
});
