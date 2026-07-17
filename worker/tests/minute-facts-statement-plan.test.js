import assert from 'node:assert/strict';
import test from 'node:test';

import { minuteFactStatements } from '../src/minute-facts-statement-plan.js';

function fakeDb() {
  return {
    prepared: [],
    prepare(sql) {
      const statement = {
        sql: String(sql),
        bind() { return this; },
      };
      this.prepared.push(statement);
      return statement;
    },
  };
}

function fact(overrides = {}) {
  return {
    channel_id: 318,
    minute_at: 1_700_000_000_000,
    observed_at: 1_700_000_001_000,
    source_priority: 100,
    quality_score: 1,
    broadcast_session_id: 12,
    queue_revision_id: null,
    queue_available: 0,
    queue_position: null,
    ...overrides,
  };
}

test('minute fact plan includes only the active context upsert', () => {
  const db = fakeDb();
  const statements = minuteFactStatements(db, fact({
    queue_revision_id: 44,
    queue_available: 1,
    queue_position: 3,
  }));

  assert.equal(statements.length, 3);
  assert.equal(statements.some(({ sql }) => sql.includes('INSERT INTO sh_minute_fact_context_v2')), true);
  assert.equal(statements.some(({ sql }) => sql.includes('DELETE FROM sh_minute_fact_context_v2')), false);
});

test('minute fact plan includes only the active context delete', () => {
  const db = fakeDb();
  const statements = minuteFactStatements(db, fact());

  assert.equal(statements.length, 3);
  assert.equal(statements.some(({ sql }) => sql.includes('INSERT INTO sh_minute_fact_context_v2')), false);
  assert.equal(statements.some(({ sql }) => sql.includes('DELETE FROM sh_minute_fact_context_v2')), true);
});
