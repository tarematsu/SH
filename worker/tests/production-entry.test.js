import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  isMinuteFactDeriveCron,
  runProductionCron,
  runProductionScheduled,
  withBuddyPlaybackDeferred,
} from '../src/production-entry.js';

const DERIVE_CRON = '*/2 * * * *';
const REBUILD_CRON = '7,17,27,37,47,57 * * * *';

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
  assert.equal(calls[0][0], 'primary');
  assert.equal(calls[0][1], controller);
  assert.equal(calls[0][2].marker, true);
  assert.equal(calls[0][2].__DEFER_BUDDY_PLAYBACK, true);
  assert.equal(calls[0][3], ctx);
  assert.equal(calls[1][0], 'buddy');
  assert.equal(calls[1][1], env);
  assert.equal(calls[1][2].waitUntil, undefined);
  assert.equal(calls[1][3], 300_000);
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

test('production cron still schedules buddy46 after a primary failure', async () => {
  const calls = [];
  const waitUntilTasks = [];
  const primaryError = new Error('primary failed');
  const run = runProductionScheduled(
    { scheduledTime: 300_000 },
    {},
    { waitUntil(task) { waitUntilTasks.push(task); } },
    {
      scheduleBuddyPlayback() {
        calls.push('buddy-start');
        return Promise.resolve('buddy-done');
      },
      app: {
        async scheduled() {
          calls.push('primary-start');
          throw primaryError;
        },
      },
    },
  );

  await assert.rejects(run, primaryError);
  assert.deepEqual(calls, ['primary-start', 'buddy-start']);
  assert.equal(waitUntilTasks.length, 1);
  assert.equal(await waitUntilTasks[0], 'buddy-done');
});

test('derive cron bypasses primary collection and buddy playback', async () => {
  const calls = [];
  const controller = { scheduledTime: 360_000, cron: DERIVE_CRON };
  const env = { marker: true };
  const result = await runProductionCron(controller, env, {}, {
    async runMinuteFactDeriveCron(receivedEnv) {
      calls.push(['derive', receivedEnv]);
      return { processed: 2 };
    },
    app: {
      async scheduled() {
        calls.push(['primary']);
      },
    },
    async scheduleBuddyPlayback() {
      calls.push(['buddy']);
    },
  });

  assert.deepEqual(result, { processed: 2 });
  assert.deepEqual(calls, [['derive', env]]);
  assert.equal(isMinuteFactDeriveCron(controller), true);
  assert.equal(isMinuteFactDeriveCron({ cron: '* * * * *' }), false);
});

test('production primary env defers inner buddy playback without mutating the original env', () => {
  const env = { marker: true };
  const deferred = withBuddyPlaybackDeferred(env);
  assert.notEqual(deferred, env);
  assert.equal(deferred.marker, true);
  assert.equal(deferred.__DEFER_BUDDY_PLAYBACK, true);
  assert.equal('__DEFER_BUDDY_PLAYBACK' in deferred, true);
  assert.equal(env.__DEFER_BUDDY_PLAYBACK, undefined);
});

test('Wrangler deploys capture, derive, and rebuild crons through the production wrapper', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.main, 'src/production-entry.js');
  assert.deepEqual(config.triggers?.crons, ['* * * * *', DERIVE_CRON, REBUILD_CRON]);
});
