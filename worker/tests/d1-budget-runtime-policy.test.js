import assert from 'node:assert/strict';
import test from 'node:test';

import { historicalRebuildEnabled } from '../src/historical-rebuild-policy.js';
import { pendingMinuteDeriveTriggers } from '../src/minute-derive-trigger.js';
import {
  processMinuteMaintenanceGate,
} from '../src/minute-rebuild-maintenance-entry.js';
import { processMinuteRebuildBatch } from '../src/minute-rebuild-batched-entry.js';
import {
  processMinutePipelineBatch,
  REBUILD_DERIVE_QUEUE_NAME,
} from '../src/minute-pipeline-entry.js';

function message(body) {
  const events = [];
  return {
    body,
    events,
    ack() { events.push('ack'); },
    retry() { events.push('retry'); },
  };
}

test('historical rebuild policy is explicitly disabled in the production budget mode', () => {
  assert.equal(historicalRebuildEnabled({ HISTORICAL_REBUILD_ENABLED: false }), false);
  assert.equal(historicalRebuildEnabled({ HISTORICAL_REBUILD_ENABLED: 'false' }), false);
  assert.equal(historicalRebuildEnabled({ HISTORICAL_REBUILD_ENABLED: true }), true);
  assert.equal(historicalRebuildEnabled({}), true);
});

test('rebuild maintenance is skipped before collector or D1 work when disabled', async () => {
  let checked = false;
  let sent = false;
  const result = await processMinuteMaintenanceGate({ HISTORICAL_REBUILD_ENABLED: false }, {
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    stage: 'maintenance-gate',
    maintenance_task: 'rebuild',
    run_id: 'budget-test',
    scheduled_at: 1_800_000,
  }, {
    async checkCollector() { checked = true; return { ready: true }; },
    async send() { sent = true; },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'historical-rebuild-disabled-for-d1-budget');
  assert.equal(checked, false);
  assert.equal(sent, false);
});

test('sync maintenance remains active while historical rebuilding is disabled', async () => {
  const sent = [];
  const result = await processMinuteMaintenanceGate({ HISTORICAL_REBUILD_ENABLED: false }, {
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    stage: 'maintenance-gate',
    maintenance_task: 'sync',
    run_id: 'sync-test',
    scheduled_at: 1_800_000,
  }, {
    async checkCollector() { return { ready: true }; },
    async send(body) { sent.push(body); },
  });
  assert.equal(result.pending, true);
  assert.equal(result.dispatched_stage, 'maintenance-run');
  assert.equal(sent[0].stage, 'maintenance-run');
});

test('historical derive backlog is acknowledged without loading the D1 handler', async () => {
  const queued = message({ message_type: 'minute-fact-derive' });
  let delegated = false;
  await processMinutePipelineBatch({
    queue: REBUILD_DERIVE_QUEUE_NAME,
    messages: [queued],
  }, { HISTORICAL_REBUILD_ENABLED: false }, null, {
    derive: {
      async processMessage() { delegated = true; },
    },
  });
  assert.deepEqual(queued.events, ['ack']);
  assert.equal(delegated, false);
});

test('queued historical rebuild stages drain without D1 work', async () => {
  const queued = message({
    message_type: 'minute-rebuild-stage',
    message_version: 1,
    stage: 'backfill',
  });
  let delegated = false;
  await processMinuteRebuildBatch({ messages: [queued] }, {
    HISTORICAL_REBUILD_ENABLED: false,
  }, null, {
    async processMinuteRebuildStage() { delegated = true; },
  });
  assert.deepEqual(queued.events, ['ack']);
  assert.equal(delegated, false);
});

test('recovery dispatch excludes durable rebuild jobs with indexable predicates', async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const record = { sql, args: [] };
      statements.push(record);
      return {
        bind(...args) { record.args = args; return this; },
        async all() { return { results: [] }; },
      };
    },
  };
  assert.deepEqual(await pendingMinuteDeriveTriggers({
    MINUTE_DB: db,
    HISTORICAL_REBUILD_ENABLED: false,
  }, { now: 123, limit: 2 }), []);
  assert.equal(statements.length, 2);
  for (const statement of statements) {
    assert.match(statement.sql, /job_kind!='rebuild'/);
    assert.doesNotMatch(statement.sql, /\sOR\s/);
    assert.deepEqual(statement.args, [123, 2]);
  }
});
