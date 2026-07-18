import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchPendingMinuteFacts } from '../src/minute-maintenance-entry.js';
import {
  markSparseRevisionRecoveryDispatched,
  pendingSparseRevisionTasks,
} from '../src/minute-revision-recovery.js';

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }

  async all() {
    this.db.reads.push({ sql: this.sql, args: this.args });
    return { results: this.db.rows };
  }

  async run() {
    this.db.writes.push({ sql: this.sql, args: this.args });
    return { meta: { changes: this.args.length > 1 ? this.args.length - 1 : 0 } };
  }
}

class FakeDb {
  constructor(rows = []) {
    this.rows = rows;
    this.reads = [];
    this.writes = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }
}

const recoveryRow = {
  revision_id: 60,
  source_job_id: 7,
  source_visible_count: 6,
  item_count: 80,
  channel_id: 10,
  station_id: 20,
  session_id: 50,
  queue_id: 40,
  queue_start_time: 10_000,
  structural_hash: 'hash-1',
  minute_at: 360_000,
  observed_at: 370_000,
  payload_version: 1,
  job_kind: 'live',
  attempts: 1,
  host_account_id: 30,
  host_handle: 'host',
  broadcast_start_time: 5_000,
  is_broadcasting: 1,
  is_paused: 0,
};

test('recovery reconstructs a compact materialization task from the durable minute job', async () => {
  const db = new FakeDb([recoveryRow]);
  const tasks = await pendingSparseRevisionTasks({ MINUTE_DB: db }, {
    now: 1_000_000,
    staleMs: 120_000,
    limit: 1,
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].stage, 'revision-materialize');
  assert.equal(tasks[0].job.id, 7);
  assert.equal(tasks[0].revision.revision_id, 60);
  assert.equal(tasks[0].revision.visible_item_count, 6);
  assert.equal(tasks[0].revision.total_item_count, 80);
  assert.equal(tasks[0].revision.queue_identity.source_structural_hash, 'hash-1');
  assert.equal(Object.hasOwn(tasks[0], 'payload'), false);
  assert.equal(db.reads.length, 1);
  assert.match(db.reads[0].sql, /coverage_complete/);
  assert.match(db.reads[0].sql, /sh_minute_fact_jobs/);
});

test('recovery dispatch checkpoint is updated only after the Queue handoff', async () => {
  const db = new FakeDb();
  const result = await markSparseRevisionRecoveryDispatched({ MINUTE_DB: db }, [60, 61], 1_000_000);

  assert.equal(result.marked, 2);
  assert.deepEqual(db.writes[0].args, [1_000_000, 60, 61]);
});

test('minute maintenance dispatches fact triggers and one stalled revision together', async () => {
  const batches = [];
  const marked = [];
  const recoveryTask = {
    message_type: 'minute-fact-derive-stage',
    message_version: 1,
    stage: 'revision-materialize',
    job: { id: 7 },
    revision: { sparse: true, revision_id: 60 },
  };
  const summary = await dispatchPendingMinuteFacts({
    MINUTE_DB: {},
    DERIVE_DISPATCH_LIMIT: 5,
    DERIVE_REVISION_RECOVERY_LIMIT: 1,
    MINUTE_DERIVE_QUEUE: {
      async sendBatch(messages) { batches.push(messages); },
    },
  }, {
    load: async () => [{ message_type: 'minute-fact-derive', channel_id: 10, minute_at: 360_000 }],
    loadRevisionRecovery: async () => [recoveryTask],
    markRevisionRecovery: async (_env, ids) => marked.push(...ids),
    stats: async () => ({}),
    record: async () => {},
  });

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(({ body }) => body.stage || body.message_type), [
    'minute-fact-derive',
    'revision-materialize',
  ]);
  assert.deepEqual(marked, [60]);
  assert.equal(summary.dispatched, 1);
  assert.equal(summary.revision_recoveries, 1);
});
