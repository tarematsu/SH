import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { requestWithParsedJson } from '../site/functions/lib/parsed-request.js';
import { saveStationSnapshot } from '../site/functions/api/host-ingest.js';
import {
  OFFICIAL_HEALTH_SQL,
  OFFICIAL_PROBE_CONTEXT_SQL,
  loadOfficialHealthState,
  loadOfficialProbeContext,
  officialCommentWriteCounts,
  officialCommentsToWrite,
} from '../worker/src/official-news-index.js';

test('parsed request wrapper reuses one consumed JSON body', async () => {
  const request = new Request('https://example.test/host-ingest', {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'legacy', data: { value: 1 } }),
  });
  const body = await request.json();
  const wrapped = requestWithParsedJson(request, body);
  assert.deepEqual(await wrapped.json(), body);
  assert.deepEqual(await wrapped.json(), body);
  assert.equal(wrapped.method, 'POST');
  assert.equal(wrapped.headers.get('authorization'), 'Bearer secret');
});

test('normal host snapshot batches snapshot and session aggregate updates', async () => {
  let runCalls = 0;
  const batches = [];
  const snapshotStatement = {
    kind: 'snapshot',
    bind() { return this; },
    async run() { runCalls += 1; },
  };
  const sessionStatement = {
    kind: 'session',
    bind() { return this; },
    async run() { runCalls += 1; },
  };
  const db = {
    prepare(sql) {
      if (sql.includes('FROM sh_host_broadcast_sessions sessions')) {
        return {
          bind() { return this; },
          async first() {
            return {
              listener_sum: 100,
              listener_sample_count: 5,
              peak_listeners: 20,
              snapshot_id: 9,
              old_listener: 10,
            };
          },
        };
      }
      if (sql.includes('UPDATE sh_host_station_snapshots SET')) return snapshotStatement;
      if (sql.includes('UPDATE sh_host_broadcast_sessions SET')) return sessionStatement;
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async batch(statements) { batches.push(statements); },
  };

  await saveStationSnapshot(db, 1_000_000, {
    session_id: 1,
    listener_count: 15,
    total_listens: 1000,
  });

  assert.equal(runCalls, 0);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((statement) => statement.kind), ['snapshot', 'session']);
});

test('official probe context loads worker session and Buddies station from their owning databases', async () => {
  let prepares = 0;
  let firstCalls = 0;
  const env = {
    OTHER_DB: {
      prepare(sql) {
        prepares += 1;
        assert.match(sql, /sh_worker_collector_state/);
        return {
          async first() {
            firstCalls += 1;
            return { auth_token: 'token', device_uid: 'device' };
          },
        };
      },
    },
    FACTS_DB: {
      prepare(sql) {
        prepares += 1;
        assert.match(sql, /sh_queue_read_model_current/);
        return {
          async first() {
            firstCalls += 1;
            return { buddies_station_id: 123 };
          },
        };
      },
    },
  };
  const value = await loadOfficialProbeContext(env);
  assert.equal(prepares, 2);
  assert.equal(firstCalls, 2);
  assert.equal(value.buddies_station_id, 123);
});

test('official health state combines monitor and announcement counts in one query', async () => {
  let prepares = 0;
  let binds = null;
  const env = {
    OTHER_DB: {
      prepare(sql) {
        prepares += 1;
        assert.equal(sql, OFFICIAL_HEALTH_SQL);
        return {
          bind(...values) { binds = values; return this; },
          async first() { return { upcoming_count: 2, active_count: 1 }; },
        };
      },
    },
  };
  const state = await loadOfficialHealthState(env, 5000);
  assert.equal(prepares, 1);
  assert.deepEqual(binds, [5000, 'official-news']);
  assert.equal(state.active_count, 1);
});

test('official comments serialize each comment once instead of once per announcement', () => {
  const announcements = [{ id: 10 }, { id: 20 }, { id: 30 }];
  const comments = [
    { commentId: 1, raw: { text: 'one' } },
    { commentId: 2, raw: { text: 'two' } },
  ];
  const originalStringify = JSON.stringify;
  let stringifyCalls = 0;
  JSON.stringify = (...args) => {
    stringifyCalls += 1;
    return originalStringify(...args);
  };
  try {
    const rows = officialCommentsToWrite(announcements, comments, []);
    assert.equal(rows.length, 6);
    assert.equal(stringifyCalls, comments.length);
    assert.deepEqual([...officialCommentWriteCounts(rows).entries()], [[10, 2], [20, 2], [30, 2]]);
  } finally {
    JSON.stringify = originalStringify;
  }
});

test('history performance layer keeps summary values while using shared formatters', () => {
  const source = readFileSync(new URL('../site/public/history/history-track-performance.js', import.meta.url), 'utf8');
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '' });
    return nodes.get(selector);
  };
  const context = {
    window: {
      fetch: async () => new Response('{}'),
      location: { href: 'https://example.test/history/' },
    },
    URL,
    Intl,
    Date,
    Number,
    Math,
    Set,
    Map,
    Response,
    finiteNumber(value) {
      if (value == null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    },
    $: node,
    formatDate() {},
    displayCell() {},
    updateSummary() {},
  };
  vm.runInNewContext(source, context);

  context.updateSummary([
    { listener_avg: 10, stream_growth: 20, member_growth: 2 },
    { listener_avg: 20, stream_growth: 40, member_growth: 4 },
  ], 'daily');
  assert.equal(node('#periods').textContent, '2');
  assert.equal(node('#maxListener').textContent, '15');
  assert.equal(node('#streamGrowth').textContent, '30');
  assert.equal(node('#memberGrowth').textContent, '3');
  assert.equal(context.formatDate('2026-07-02'), '2026/07/02');
});
