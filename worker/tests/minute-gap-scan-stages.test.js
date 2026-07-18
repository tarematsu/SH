import assert from 'node:assert/strict';
import test from 'node:test';

import { processMinuteRebuildStage } from '../src/minute-rebuild-entry.js';

const body = {
  message_type: 'minute-rebuild-stage',
  message_version: 1,
  run_id: 'minute-rebuild:123',
  scheduled_at: 123,
};

function env() {
  return { BUDDIES_DB: {}, MINUTE_DB: {} };
}

test('minute rebuild separates gap discovery from candidate commit', async () => {
  const enqueued = [];
  const recorded = [];
  const prepared = {
    from: 60_000,
    to: 120_000,
    expected_minutes: 1,
    missing_minutes: 1,
    attempted: [{ minuteAt: 60_000 }],
  };
  const common = {
    async enqueueStage(_env, _task, stage, delaySeconds = 0, details = null) {
      enqueued.push({ stage, delaySeconds, details });
    },
    async recordStage(_env, task, result) {
      recorded.push({ stage: task.stage, result });
    },
  };

  const scan = await processMinuteRebuildStage(env(), { ...body, stage: 'gap-scan' }, {
    ...common,
    prepareGapScan: async () => prepared,
  });
  const commit = await processMinuteRebuildStage(env(), {
    ...body,
    stage: 'gap-commit',
    prepared,
  }, {
    ...common,
    commitGapScan: async (_active, value) => {
      assert.equal(value, prepared);
      return { event: 'minute_fact_gap_scan_summary', enqueued: 1 };
    },
  });

  assert.equal(scan.result.event, 'minute_fact_gap_scan_prepared');
  assert.equal(commit.result.enqueued, 1);
  assert.deepEqual(enqueued.map((item) => item.stage), ['gap-commit', 'backfill']);
  assert.equal(enqueued[0].details.prepared, prepared);
  assert.deepEqual(recorded.map((item) => item.stage), ['gap-scan']);
});

test('empty gap scans bypass commit and continue to backfill', async () => {
  const stages = [];
  const result = await processMinuteRebuildStage(env(), { ...body, stage: 'gap-scan' }, {
    prepareGapScan: async () => ({
      event: 'minute_fact_gap_scan_summary',
      skipped: true,
      reason: 'no-source-data',
    }),
    recordStage: async () => {},
    enqueueStage: async (_env, _task, stage) => stages.push(stage),
  });

  assert.equal(result.result.skipped, true);
  assert.deepEqual(stages, ['backfill']);
});
