import assert from 'node:assert/strict';
import test from 'node:test';

import { minuteFactStatements } from '../src/minute-facts-statement-plan.js';

function fakeDb() {
  return {
    prepared: [],
    prepare(sql) {
      const statement = {
        sql: String(sql),
        params: [],
        bind(...params) { this.params = params; return this; },
      };
      this.prepared.push(statement);
      return statement;
    },
  };
}

function fact(overrides = {}) {
  return {
    channel_id: 318,
    minute_at: 1_700_000_100_000,
    observed_at: 1_700_000_101_000,
    source_code: 1,
    source_priority: 100,
    quality_score: 1,
    broadcast_session_id: 12,
    queue_revision_id: null,
    queue_available: 0,
    queue_position: null,
    ...overrides,
  };
}

test('boundary minute plan finalizes one dashboard bucket and uses the active context upsert', () => {
  const db = fakeDb();
  const statements = minuteFactStatements(db, fact({
    queue_revision_id: 44,
    queue_available: 1,
    queue_position: 3,
  }));
  const rollup = statements.find(({ sql }) => sql.includes('INSERT INTO sh_dashboard_history_5m'));

  assert.equal(statements.length, 4);
  assert.ok(rollup);
  assert.deepEqual(rollup.params.slice(1), [1_699_999_800_000, 1_700_000_100_000, 1_699_999_800_000]);
  assert.equal(statements.some(({ sql }) => sql.includes('INSERT INTO sh_minute_fact_context_v2')), true);
  assert.equal(statements.some(({ sql }) => sql.includes('DELETE FROM sh_minute_fact_context_v2')), false);
});

test('non-boundary minute retries the same completed bucket for catch-up without changing context ownership', () => {
  const db = fakeDb();
  const statements = minuteFactStatements(db, fact({ minute_at: 1_700_000_160_000 }));
  const rollup = statements.find(({ sql }) => sql.includes('INSERT INTO sh_dashboard_history_5m'));

  assert.equal(statements.length, 4);
  assert.ok(rollup);
  assert.deepEqual(rollup.params.slice(1), [1_699_999_800_000, 1_700_000_100_000, 1_699_999_800_000]);
  assert.equal(statements.some(({ sql }) => sql.includes('INSERT INTO sh_minute_fact_context_v2')), false);
  assert.equal(statements.some(({ sql }) => sql.includes('DELETE FROM sh_minute_fact_context_v2')), true);
});
