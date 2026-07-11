import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFER_AUXILIARY_RUNNERS_FLAG,
  resetPrimaryScheduledFlightForTests,
  runPrimaryScheduled,
  shouldDeferAuxiliaryRunners,
} from '../src/scheduled-main.js';

function trackingDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      return {
        bind() { return this; },
        async first() { return null; },
        async run() { return { meta: { changes: 0 } }; },
      };
    },
  };
}

function baseEnv(extra = {}) {
  return {
    DB: trackingDb(),
    WEEKLY_LEADERBOARD_ENABLED: 'false',
    DATA_MAINTENANCE_ENABLED: 'false',
    ...extra,
  };
}

test('shouldDeferAuxiliaryRunners reads the buddies-worker defer flag', () => {
  assert.equal(shouldDeferAuxiliaryRunners({}), false);
  assert.equal(shouldDeferAuxiliaryRunners({ [DEFER_AUXILIARY_RUNNERS_FLAG]: true }), true);
});

test('primary schedule runs the weekly/prediction/maintenance auxiliaries when not deferred', async () => {
  resetPrimaryScheduledFlightForTests();
  const env = baseEnv();
  const waitUntilTasks = [];
  const ctx = { waitUntil: (task) => waitUntilTasks.push(task) };
  const scheduled = async () => 'primary-done';

  const result = await runPrimaryScheduled({ cron: '* * * * *' }, env, ctx, scheduled, 5000);
  await Promise.allSettled(waitUntilTasks);

  assert.equal(result, 'primary-done');
  assert.ok(
    env.DB.calls.some((sql) => sql.includes('sh_stream_goal_prediction_state')),
    'expected the stream goal prediction claim to run when auxiliaries are not deferred',
  );
  resetPrimaryScheduledFlightForTests();
});

test('buddies worker defers the weekly/prediction/maintenance auxiliaries to the other worker', async () => {
  resetPrimaryScheduledFlightForTests();
  const env = baseEnv({ [DEFER_AUXILIARY_RUNNERS_FLAG]: true });
  const waitUntilTasks = [];
  const ctx = { waitUntil: (task) => waitUntilTasks.push(task) };
  const scheduled = async () => 'primary-done';

  const result = await runPrimaryScheduled({ cron: '* * * * *' }, env, ctx, scheduled, 5000);
  await Promise.allSettled(waitUntilTasks);

  assert.equal(result, 'primary-done');
  assert.equal(env.DB.calls.length, 0, 'expected no auxiliary D1 access when deferred to the other worker');
  resetPrimaryScheduledFlightForTests();
});

test('an explicit auxiliaryRunners override still wins over the defer flag', async () => {
  resetPrimaryScheduledFlightForTests();
  const env = baseEnv({ [DEFER_AUXILIARY_RUNNERS_FLAG]: true });
  const waitUntilTasks = [];
  const ctx = { waitUntil: (task) => waitUntilTasks.push(task) };
  const scheduled = async () => 'primary-done';
  let ran = false;

  await runPrimaryScheduled({ cron: '* * * * *' }, env, ctx, scheduled, 5000, {
    auxiliaryRunners: { custom: { run: async () => { ran = true; } } },
  });
  await Promise.allSettled(waitUntilTasks);

  assert.equal(ran, true);
  resetPrimaryScheduledFlightForTests();
});
