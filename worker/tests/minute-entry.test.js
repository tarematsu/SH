import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import minuteApp, {
  activeMinuteHealthTasks,
  MINUTE_FACT_DERIVE_CRON,
  MINUTE_FACT_REBUILD_CRON,
  MINUTE_FACT_RECOVERY_MINUTE,
  MINUTE_FACT_WORKER_CRON,
  minuteStaggerApplies,
  runMinuteScheduled,
} from '../src/minute-entry.js';

test('minute worker routes derive and rebuild through the buddies source only', async () => {
  const buddiesDb = { name: 'buddies' };
  const env = { BUDDIES_DB: buddiesDb };

  assert.equal(await runMinuteScheduled({ cron: MINUTE_FACT_DERIVE_CRON }, env, {
    runDerive: async (activeEnv) => {
      assert.equal(activeEnv.DB, buddiesDb);
      return 'derive';
    },
  }), 'derive');
  assert.equal(await runMinuteScheduled({ cron: MINUTE_FACT_REBUILD_CRON }, env, {
    runRebuild: async (activeEnv) => {
      assert.equal(activeEnv.DB, buddiesDb);
      return 'rebuild';
    },
  }), 'rebuild');
  assert.equal(Object.hasOwn(env, 'DB'), false);
});
test('single minute-worker cron runs derive and rebuild in separate slots', async () => {
  const calls = [];
  const env = { BUDDIES_DB: { name: 'buddies' } };
  const run = (minute) => runMinuteScheduled({ cron: MINUTE_FACT_WORKER_CRON, scheduledTime: minute * 60_000 }, env, {
    runDerive: async (activeEnv) => { calls.push(`derive:${activeEnv.DB.name}`); return 'derive'; },
    runRebuild: async (activeEnv) => { calls.push(`rebuild:${activeEnv.DB.name}`); return 'rebuild'; },
  });
  assert.equal(await run(2), 'derive');
  assert.equal(await run(7), 'rebuild');
  assert.deepEqual(await run(9), { skipped: true, reason: 'not-due', minute: 9 });
  assert.deepEqual(calls, ['derive:buddies', 'rebuild:buddies']);
});
test('minute worker retries a bounded set of dead jobs in its recovery slot', async () => {
  const result = await runMinuteScheduled({ cron: MINUTE_FACT_WORKER_CRON, scheduledTime: MINUTE_FACT_RECOVERY_MINUTE * 60_000 }, { MINUTE_FACT_AUTO_REQUEUE_DEAD: true }, {
    requeueDead: async (_env, options) => ({ requeued: options.limit }),
  });
  assert.deepEqual(result, { requeued: undefined });
});

test('minute worker has dedicated name, source bindings and one routing cron', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.minute.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.name, 'sh-monitor-minute');
  assert.equal(config.main, 'src/minute-entry.js');
  assert.deepEqual(config.triggers.crons, [MINUTE_FACT_WORKER_CRON]);
  assert.deepEqual(config.d1_databases.map(({ binding }) => binding), ['BUDDIES_DB', 'MINUTE_DB']);
  assert.deepEqual(config.d1_databases.map(({ database_name }) => database_name), [
    'stationhead-buddies',
    'stationhead-minute',
  ]);
});

test('minute stagger applies only to shared source database jobs', () => {
  assert.equal(minuteStaggerApplies({ cron: MINUTE_FACT_DERIVE_CRON }), false);
  assert.equal(minuteStaggerApplies({ cron: MINUTE_FACT_REBUILD_CRON }), true);
  assert.equal(minuteStaggerApplies({ cron: MINUTE_FACT_WORKER_CRON, scheduledTime: 2 * 60_000 }), true);
  assert.equal(minuteStaggerApplies({ cron: MINUTE_FACT_WORKER_CRON, scheduledTime: 7 * 60_000 }), true);
  assert.equal(minuteStaggerApplies({ cron: MINUTE_FACT_WORKER_CRON, scheduledTime: 9 * 60_000 }), true);
});

test('minute health includes only active derive, recovery and rebuild jobs', () => {
  assert.deepEqual(activeMinuteHealthTasks([
    { task_name: 'derive' },
    { task_name: 'recovery' },
    { task_name: 'rebuild' },
    { task_name: 'retired' },
  ]).map(({ task_name }) => task_name), ['derive', 'recovery', 'rebuild']);
});

test('minute worker /health responses are cached across repeated requests', async () => {
  let reads = 0;
  const env = {
    MINUTE_DB: {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          async all() {
            reads += 1;
            if (sql.includes('sh_minute_fact_runtime_state')) return { results: [] };
            return { results: [] };
          },
          async first() {
            return null;
          },
          async run() {
            return { meta: { changes: 0 } };
          },
        };
      },
    },
  };
  const request = new Request('https://example.com/health');

  const first = await minuteApp.fetch(request, env, {});
  const second = await minuteApp.fetch(request, env, {});

  assert.equal(first.status, 200);
  assert.equal(second.headers.get('x-health-cache'), 'hit');
  assert.equal(reads, 1);
});

