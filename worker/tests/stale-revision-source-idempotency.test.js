import assert from 'node:assert/strict';
import test from 'node:test';

import { retireUnavailableRevisionSource } from '../src/minute-derive-entry.js';

const NOW = 1_000_000;
const BODY = {
  message_type: 'minute-fact-derive-stage',
  message_version: 1,
  stage: 'revision-materialize',
  started_at: NOW - 6 * 60_000,
  revision: {
    revision_id: 559,
    source_job_id: 99,
    visible_item_count: 8,
    materialized_item_count: 3,
  },
};

function database({ updateChanges = 0, row = null } = {}) {
  const calls = [];
  return {
    calls,
    env: {
      MINUTE_DB: {
        prepare(sql) {
          const call = { sql, args: [] };
          calls.push(call);
          return {
            bind(...args) {
              call.args = args;
              return this;
            },
            async run() {
              return { meta: { changes: updateChanges } };
            },
            async first() {
              return row;
            },
          };
        },
      },
    },
  };
}

test('stale source retirement is idempotent after an ack-loss redelivery', async () => {
  const db = database({
    updateChanges: 0,
    row: {
      source_job_id: 99,
      source_visible_count: 3,
      materialized_item_count: 3,
      status: 'complete',
    },
  });

  assert.equal(await retireUnavailableRevisionSource(db.env, BODY, NOW), true);
  assert.equal(db.calls.length, 2);
  assert.deepEqual(db.calls[0].args, [NOW, 559, 99, 8]);
  assert.deepEqual(db.calls[1].args, [559]);
});

test('a newer visible source is never reduced by an older poison message', async () => {
  const db = database({
    updateChanges: 0,
    row: {
      source_job_id: 99,
      source_visible_count: 10,
      materialized_item_count: 3,
      status: 'pending',
    },
  });

  assert.equal(await retireUnavailableRevisionSource(db.env, BODY, NOW), false);
  assert.match(db.calls[0].sql, /source_visible_count,0\)<=\?/);
  assert.deepEqual(db.calls[0].args, [NOW, 559, 99, 8]);
});

test('retirement requires the stale message visible-count identity', async () => {
  const db = database({ updateChanges: 1 });
  const body = {
    ...BODY,
    revision: {
      revision_id: 559,
      source_job_id: 99,
      materialized_item_count: 3,
    },
  };

  assert.equal(await retireUnavailableRevisionSource(db.env, body, NOW), false);
  assert.equal(db.calls.length, 0);
});
