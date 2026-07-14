import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetPrimaryScheduledFlightForTests,
  runPrimaryScheduled,
} from '../src/scheduled-main.js';

function trackingDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      const statement = {
        params: [],
        bind(...params) { statement.params = params; return statement; },
        async first() {
          if (sql.startsWith('INSERT INTO sh_primary_run_lock')) {
            return { holder_id: statement.params[1] };
          }
          return null;
        },
        async run() { return { meta: { changes: 0 } }; },
      };
      return statement;
    },
  };
}

test('primary schedule runs no auxiliary tasks by default', async () => {
  resetPrimaryScheduledFlightForTests();
  const env = { DB: trackingDb() };
  const waitUntilTasks = [];
  const result = await runPrimaryScheduled(
    { cron: '* * * * *' },
    env,
    { waitUntil: (task) => waitUntilTasks.push(task) },
    async () => 'primary-done',
    5000,
  );
  await Promise.allSettled(waitUntilTasks);

  assert.equal(result, 'primary-done');
  assert.equal(env.DB.calls.every((sql) => sql.includes('sh_primary_run_lock')), true);
  resetPrimaryScheduledFlightForTests();
});

test('explicit auxiliary runners remain available for isolated scheduler tests', async () => {
  resetPrimaryScheduledFlightForTests();
  const env = { DB: trackingDb() };
  const waitUntilTasks = [];
  let ran = false;
  await runPrimaryScheduled(
    { cron: '* * * * *' },
    env,
    { waitUntil: (task) => waitUntilTasks.push(task) },
    async () => 'primary-done',
    5000,
    { auxiliaryRunners: { custom: { run: async () => { ran = true; } } } },
  );
  await Promise.allSettled(waitUntilTasks);

  assert.equal(ran, true);
  resetPrimaryScheduledFlightForTests();
});
