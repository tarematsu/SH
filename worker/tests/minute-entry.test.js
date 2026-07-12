import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import minuteApp, { MINUTE_FACT_DERIVE_CRON, MINUTE_FACT_LEGACY_CRON, MINUTE_FACT_REBUILD_CRON, MINUTE_FACT_RECOVERY_MINUTE, MINUTE_FACT_WORKER_CRON, runMinuteScheduled } from '../src/minute-entry.js';
import { legacyFact, runMinuteFactsLegacyBackfill } from '../src/minute-facts-legacy-backfill.js';

test('minute worker routes every creation path without running the collector', async () => {
  const calls = [];
  for (const [cron, expected] of [[MINUTE_FACT_DERIVE_CRON, 'derive'], [MINUTE_FACT_REBUILD_CRON, 'rebuild'], [MINUTE_FACT_LEGACY_CRON, 'legacy']]) {
    const result = await runMinuteScheduled({ cron }, {}, {
      runDerive: async () => { calls.push('derive'); return 'derive'; },
      runRebuild: async () => { calls.push('rebuild'); return 'rebuild'; },
      runLegacy: async () => { calls.push('legacy'); return 'legacy'; },
    });
    assert.equal(result, expected);
  }
  assert.deepEqual(calls, ['derive', 'rebuild', 'legacy']);
});

test('single minute-worker cron preserves derive, rebuild, and legacy cadence', async () => {
  const calls = [];
  const run = (minute) => runMinuteScheduled({ cron: MINUTE_FACT_WORKER_CRON, scheduledTime: minute * 60_000 }, {}, {
    runDerive: async () => { calls.push('derive'); return 'derive'; },
    runRebuild: async () => { calls.push('rebuild'); return 'rebuild'; },
    runLegacy: async () => { calls.push('legacy'); return 'legacy'; },
  });
  assert.equal(await run(2), 'derive');
  assert.equal(await run(7), 'rebuild');
  assert.equal(await run(9), 'legacy');
  assert.deepEqual(calls, ['derive', 'rebuild', 'legacy']);
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
  assert.deepEqual(config.d1_databases.map(({ binding }) => binding), ['DB', 'FACTS_DB']);
});

test('legacy fact creation is enabled in the dedicated worker', async () => {
  const result = await runMinuteFactsLegacyBackfill({}, {});
  assert.deepEqual(result, { skipped: true, reason: 'legacy-db-binding-missing' });
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
