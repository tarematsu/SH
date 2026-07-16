import assert from 'node:assert/strict';
import test from 'node:test';

import {
  latestFactPointers,
  loadLatestFacts,
  minuteFactsRowsSql,
} from '../functions/api/minute-facts/index.js';

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async all() {
    this.db.calls.push({ method: 'all', sql: this.sql, params: this.params });
    return { results: this.db.rows };
  }

  async first() {
    this.db.calls.push({ method: 'first', sql: this.sql, params: this.params });
    return this.db.fallbackLive;
  }
}

class FakeDb {
  constructor(rows, fallbackLive = null) {
    this.rows = rows;
    this.fallbackLive = fallbackLive;
    this.calls = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }
}

function fact(id, sourceCode, minuteAt) {
  return {
    id,
    source_code: sourceCode,
    track_detection_code: 0,
    minute_at: minuteAt,
    observed_at: minuteAt + 1,
    received_at: minuteAt + 2,
  };
}

test('latest minute facts use base tables and indexed current counters', () => {
  const sql = minuteFactsRowsSql({ latest: true });
  assert.match(sql, /sh_minute_fact_context_v2/);
  assert.match(sql, /sh_track_counter_current/);
  assert.match(sql, /sh_total_member_daily host_total/);
  assert.match(sql, /sh_total_member_daily generic_total/);
  assert.doesNotMatch(sql, /LEFT JOIN sh_minute_fact_context c/);
  assert.doesNotMatch(sql, /SELECT cc\.count_value FROM sh_track_counter_changes/);
  assert.doesNotMatch(sql, /SELECT d\.last_total_member_count/);
});

test('historical filtered queries retain the compatibility view path', () => {
  const sql = minuteFactsRowsSql({ host: true, track: true });
  assert.match(sql, /LEFT JOIN sh_minute_fact_context c/);
  assert.match(sql, /SELECT d\.last_total_member_count/);
  assert.doesNotMatch(sql, /sh_track_counter_current counter/);
});

test('latest pointers are derived from the already loaded descending rows', () => {
  const pointers = latestFactPointers([
    fact(3, 2, 300),
    fact(2, 1, 200),
    fact(1, 1, 100),
  ]);
  assert.deepEqual(pointers.latestAny, {
    id: 3,
    source_code: 2,
    minute_at: 300,
    observed_at: 301,
    received_at: 302,
    source: 'live_reconstructed',
  });
  assert.equal(pointers.latestLive.id, 2);
  assert.equal(pointers.latestLive.source, 'live_collector');
});

test('normal current refresh performs one D1 query when a live row is in the window', async () => {
  const db = new FakeDb([
    fact(3, 2, 300),
    fact(2, 1, 200),
    fact(1, 2, 100),
  ]);
  const result = await loadLatestFacts({ MINUTE_DB: db }, 3);

  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].method, 'all');
  assert.equal(result.latest_any.id, 3);
  assert.equal(result.latest_live.id, 2);
  assert.deepEqual(result.rows.map(({ id }) => id), [1, 2, 3]);
});

test('current refresh queries older live state only when the full window has none', async () => {
  const fallbackLive = fact(1, 1, 100);
  const db = new FakeDb([
    fact(3, 2, 300),
    fact(2, 2, 200),
  ], fallbackLive);
  const result = await loadLatestFacts({ MINUTE_DB: db }, 2);

  assert.deepEqual(db.calls.map(({ method }) => method), ['all', 'first']);
  assert.match(db.calls[1].sql, /WHERE source_code=1/);
  assert.equal(result.latest_live.id, 1);
  assert.equal(result.latest_observed_at, 101);
});

test('no fallback query is needed when the result is shorter than the limit', async () => {
  const db = new FakeDb([fact(2, 2, 200)]);
  const result = await loadLatestFacts({ MINUTE_DB: db }, 3);

  assert.equal(db.calls.length, 1);
  assert.equal(result.latest_live, null);
  assert.equal(result.latest_observed_at, null);
});
