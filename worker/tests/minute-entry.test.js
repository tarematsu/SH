import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import minuteApp, {
  activeMinuteHealthTasks,
  MINUTE_COMMENT_CRON,
  MINUTE_FACT_DERIVE_CRON,
  MINUTE_FACT_RECOVERY_CRON,
  MINUTE_FACT_REBUILD_CRON,
  MINUTE_FACT_SYNC_CRON,
  MINUTE_FACT_WORKER_CRON,
  minuteStaggerApplies,
  runMinuteScheduled,
  runMinuteScheduledWithCollectorPriority,
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

test('minute cron expressions isolate comments, derive, recovery, rebuild and sync', async () => {
  const calls = [];
  const env = {
    BUDDIES_DB: { name: 'buddies' },
    MINUTE_FACT_AUTO_REQUEUE_DEAD: true,
    MINUTE_FACT_DEAD_REQUEUE_LIMIT: 20,
  };
  const dependencies = {
    runComments: async () => { calls.push('comments'); return 'comments'; },
    runDerive: async () => { calls.push('derive'); return 'derive'; },
    requeueDead: async (_env, options) => { calls.push(`recovery:${options.limit}`); return 'recovery'; },
    runRebuild: async () => { calls.push('rebuild'); return 'rebuild'; },
    runSync: async () => { calls.push('sync'); return 'sync'; },
  };

  assert.equal(await runMinuteScheduled({ cron: MINUTE_COMMENT_CRON }, env, dependencies), 'comments');
  assert.equal(await runMinuteScheduled({ cron: MINUTE_FACT_DERIVE_CRON }, env, dependencies), 'derive');
  assert.equal(await runMinuteScheduled({ cron: MINUTE_FACT_RECOVERY_CRON }, env, dependencies), 'recovery');
  assert.equal(await runMinuteScheduled({ cron: MINUTE_FACT_REBUILD_CRON }, env, dependencies), 'rebuild');
  assert.equal(await runMinuteScheduled({ cron: MINUTE_FACT_SYNC_CRON }, env, dependencies), 'sync');
  assert.deepEqual(calls, ['comments', 'derive', 'recovery:20', 'rebuild', 'sync']);
});

test('derive avoids collector stagger and readiness reads', async () => {
  const calls = [];
  const result = await runMinuteScheduledWithCollectorPriority(
    { cron: MINUTE_FACT_DERIVE_CRON },
    { BUDDIES_DB: { name: 'buddies' } },
    {},
    {
      applyStagger: async () => { calls.push('stagger'); },
      waitForCollector: async () => { calls.push('wait'); return { ready: false }; },
      runDerive: async () => { calls.push('derive'); return 'derive'; },
    },
  );

  assert.equal(result, 'derive');
  assert.deepEqual(calls, ['derive']);
});

test('collector priority timeout does not suppress snapshot rebuild', async () => {
  const calls = [];
  const result = await runMinuteScheduledWithCollectorPriority(
    { cron: MINUTE_FACT_REBUILD_CRON, scheduledTime: 120_000 },
    { BUDDIES_DB: { name: 'buddies' } },
    {},
    {
      applyStagger: async () => { calls.push('stagger'); },
      waitForCollector: async () => ({ ready: false, reason: 'collector-not-ready', targetMinute: 120_000 }),
      runRebuild: async () => { calls.push('rebuild'); return 'rebuild'; },
    },
  );

  assert.equal(result, 'rebuild');
  assert.deepEqual(calls, ['stagger', 'rebuild']);
});

test('collector priority timeout skips only optional buddies synchronization', async () => {
  const calls = [];
  const result = await runMinuteScheduledWithCollectorPriority(
    { cron: MINUTE_FACT_SYNC_CRON, scheduledTime: 120_000 },
    { BUDDIES_DB: { name: 'buddies' } },
    {},
    {
      applyStagger: async () => { calls.push('stagger'); },
      waitForCollector: async () => ({ ready: false, reason: 'collector-not-ready', targetMinute: 120_000 }),
      runSync: async () => { calls.push('sync'); return 'sync'; },
    },
  );

  assert.deepEqual(result, { skipped: true, reason: 'collector-not-ready' });
  assert.deepEqual(calls, ['stagger']);
});

test('minute worker has dedicated bindings and isolated cron workloads', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.minute.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.name, 'sh-monitor-minute');
  assert.equal(config.main, 'src/minute-entry.js');
  assert.deepEqual(config.triggers.crons, [
    MINUTE_COMMENT_CRON,
    MINUTE_FACT_DERIVE_CRON,
    MINUTE_FACT_RECOVERY_CRON,
    MINUTE_FACT_REBUILD_CRON,
    MINUTE_FACT_SYNC_CRON,
  ]);
  assert.equal(MINUTE_FACT_WORKER_CRON, MINUTE_COMMENT_CRON);
  assert.deepEqual(config.d1_databases.map(({ binding }) => binding), ['BUDDIES_DB', 'MINUTE_DB']);
  assert.equal(config.vars.MINUTE_FACT_AUTO_REQUEUE_DEAD, true);
  assert.equal(config.vars.REBUILD_RECENT_GUARD_MS, 300_000);
});

test('minute stagger applies only to rebuild and sync jobs', () => {
  assert.equal(minuteStaggerApplies({ cron: MINUTE_COMMENT_CRON }), false);
  assert.equal(minuteStaggerApplies({ cron: MINUTE_FACT_DERIVE_CRON }), false);
  assert.equal(minuteStaggerApplies({ cron: MINUTE_FACT_RECOVERY_CRON }), false);
  assert.equal(minuteStaggerApplies({ cron: MINUTE_FACT_REBUILD_CRON }), true);
  assert.equal(minuteStaggerApplies({ cron: MINUTE_FACT_SYNC_CRON }), true);
});

test('minute health includes only active task names', () => {
  assert.deepEqual(activeMinuteHealthTasks([
    { task_name: 'comments' },
    { task_name: 'derive' },
    { task_name: 'recovery' },
    { task_name: 'rebuild' },
    { task_name: 'sync' },
    { task_name: 'retired' },
  ]).map(({ task_name }) => task_name), ['comments', 'derive', 'recovery', 'rebuild', 'sync']);
});

test('minute worker /health responses are cached across repeated requests', async () => {
  let reads = 0;
  const env = {
    MINUTE_DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async all() {
            reads += 1;
            if (sql.includes('sh_minute_fact_runtime_state')) return { results: [] };
            return { results: [] };
          },
          async first() { return null; },
          async run() { return { meta: { changes: 0 } }; },
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
