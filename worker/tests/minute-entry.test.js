import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import minuteApp, { activeMinuteHealthTasks, MINUTE_FACT_DERIVE_CRON, MINUTE_FACT_RECOVERY_MINUTE, MINUTE_FACT_WORKER_CRON, runMinuteScheduled } from '../src/minute-entry.js';
import { legacyFact } from '../src/minute-facts-legacy-backfill.js';

test('minute worker routes FACTS-only derive and rejects retired shared-DB crons', async () => {
  const result = await runMinuteScheduled({ cron: MINUTE_FACT_DERIVE_CRON }, {}, {
    runDerive: async () => 'derive',
  });
  assert.equal(result, 'derive');
  assert.deepEqual(await runMinuteScheduled({ cron: '7,17,27,37,47,57 * * * *' }, {}), {
    skipped: true,
    reason: 'unsupported-minute-facts-cron',
    cron: '7,17,27,37,47,57 * * * *',
  });
});

test('single minute-worker cron runs derive and leaves odd minutes idle', async () => {
  const calls = [];
  const run = (minute) => runMinuteScheduled({ cron: MINUTE_FACT_WORKER_CRON, scheduledTime: minute * 60_000 }, {}, {
    runDerive: async () => { calls.push('derive'); return 'derive'; },
  });
  assert.equal(await run(2), 'derive');
  assert.deepEqual(await run(7), { skipped: true, reason: 'not-due', minute: 7 });
  assert.deepEqual(await run(9), { skipped: true, reason: 'not-due', minute: 9 });
  assert.deepEqual(calls, ['derive']);
});

test('minute worker retries a bounded set of dead jobs in its recovery slot', async () => {
  const result = await runMinuteScheduled({ cron: MINUTE_FACT_WORKER_CRON, scheduledTime: MINUTE_FACT_RECOVERY_MINUTE * 60_000 }, { MINUTE_FACT_AUTO_REQUEUE_DEAD: true }, {
    requeueDead: async (_env, options) => ({ requeued: options.limit }),
  });
  assert.deepEqual(result, { requeued: undefined });
});

test('minute worker has dedicated name, bindings and crons', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.minute.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.name, 'sh-monitor-minute');
  assert.equal(config.main, 'src/minute-entry.js');
  assert.deepEqual(config.triggers.crons, [MINUTE_FACT_WORKER_CRON]);
  assert.deepEqual(config.d1_databases.map(({ binding }) => binding), ['FACTS_DB']);
});

test('minute health ignores persisted runtime rows for retired jobs', () => {
  assert.deepEqual(activeMinuteHealthTasks([
    { task_name: 'derive' },
    { task_name: 'recovery' },
    { task_name: 'legacy' },
    { task_name: 'rebuild' },
  ]).map(({ task_name }) => task_name), ['derive', 'recovery']);
});

test('minute worker /health responses are cached across repeated requests', async () => {
  let reads = 0;
  const env = {
    FACTS_DB: {
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

test('legacy facts use the current numeric source and track-detection columns', () => {
  const fact = legacyFact({
    row: { source_id: 1, observed_at: 120_000 },
    channelId: 10,
    hostId: null,
    trackId: 7,
    sessionId: 3,
    source: 'legacy_normalized',
    sourcePriority: 80,
  });
  assert.equal(fact.source_code, 3);
  assert.equal(fact.track_detection_code, 0);
  assert.equal('source' in fact, false);
  assert.equal('track_detection_method' in fact, false);
});
