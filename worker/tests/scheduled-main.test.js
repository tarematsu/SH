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
      const statement = {
        boundParams: [],
        bind(...params) {
          statement.boundParams = params;
          return statement;
        },
        async first() {
          // Simulate an uncontested primary-run-lock claim so tests unrelated
          // to that mechanism don't need to know about it.
          if (sql.startsWith('INSERT INTO sh_primary_run_lock')) {
            return { holder_id: statement.boundParams[1] };
          }
          return null;
        },
        async run() { return { meta: { changes: 0 } }; },
      };
      return statement;
    },
  };
}

function baseEnv(extra = {}) {
  return {
    DB: trackingDb(),
    DATA_MAINTENANCE_ENABLED: 'false',
    ...extra,
  };
}

test('shouldDeferAuxiliaryRunners reads the buddies-worker defer flag', () => {
  assert.equal(shouldDeferAuxiliaryRunners({}), false);
  assert.equal(shouldDeferAuxiliaryRunners({ [DEFER_AUXILIARY_RUNNERS_FLAG]: true }), true);
});

test('primary schedule runs the prediction/maintenance auxiliaries when not deferred', async () => {
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

test('buddies worker defers the prediction/maintenance auxiliaries to the other worker', async () => {
  resetPrimaryScheduledFlightForTests();
  const env = baseEnv({ [DEFER_AUXILIARY_RUNNERS_FLAG]: true });
  const waitUntilTasks = [];
  const ctx = { waitUntil: (task) => waitUntilTasks.push(task) };
  const scheduled = async () => 'primary-done';

  const result = await runPrimaryScheduled({ cron: '* * * * *' }, env, ctx, scheduled, 5000);
  await Promise.allSettled(waitUntilTasks);

  assert.equal(result, 'primary-done');
  const auxiliaryCalls = env.DB.calls.filter((sql) => !sql.includes('sh_primary_run_lock'));
  assert.equal(auxiliaryCalls.length, 0, 'expected no auxiliary D1 access when deferred to the other worker');
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
