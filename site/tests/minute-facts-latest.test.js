import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildLatestMinuteFactsPayload,
  latestMinuteFactsResponse,
  onRequest,
  readLatestMinuteFacts,
} from '../functions/api/minute-facts/latest.js';

const NOW = 1_700_000_300_000;

function fact(overrides = {}) {
  return {
    id: 9,
    channel_id: 10,
    minute_at: NOW - 60_000,
    observed_at: NOW - 55_000,
    received_at: NOW - 30_000,
    source_code: 1,
    source_priority: 100,
    source_record_id: 'live:10:169999',
    collector_code: 1,
    broadcast_session_id: 3,
    is_broadcasting: 1,
    listener_count: 42,
    online_member_count: 45,
    total_member_count: 1000,
    guest_count: 3,
    reported_total_listens: 2000,
    reported_current_stream_count: 42,
    is_paused: 0,
    track_detection_code: 1,
    track_confidence_code: 95,
    schedule_valid: 1,
    comment_count: 2,
    comment_total: 50,
    comments_degraded: 0,
    quality_score_code: 98,
    quality_flags: 0,
    ...overrides,
  };
}

test('Pages latest minute facts query is fixed to five newest rows', async () => {
  let preparedSql = '';
  const rows = Array.from({ length: 6 }, (_, index) => fact({
    id: 20 - index,
    minute_at: NOW - (index + 1) * 60_000,
  }));
  const env = {
    MINUTE_DB: {
      prepare(sql) {
        preparedSql = sql;
        return { async all() { return { results: rows }; } };
      },
    },
  };

  const result = await readLatestMinuteFacts(env);

  assert.equal(result.length, 5);
  assert.match(preparedSql, /ORDER BY f\.minute_at DESC, f\.id DESC/);
  assert.match(preparedSql, /LIMIT 5/);
  assert.doesNotMatch(preparedSql, /SELECT\s+\*/i);
});

test('fresh Pages response returns monitoring metadata and readable values', async () => {
  const request = new Request('https://example.pages.dev/api/minute-facts/latest');
  const response = await latestMinuteFactsResponse(request, {
    MINUTE_FACT_API_STALE_MS: 300_000,
  }, {
    now: () => NOW,
    readLatestMinuteFacts: async () => [fact()],
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(body.ok, true);
  assert.equal(body.query_ok, true);
  assert.equal(body.stale, false);
  assert.equal(body.count, 1);
  assert.equal(body.limit, 5);
  assert.equal(body.latest_age_ms, 60_000);
  assert.equal(body.latest_received_age_ms, 30_000);
  assert.equal(body.rows[0].source, 'live_collector');
  assert.equal(body.rows[0].collector_id, 'cloudflare-worker');
  assert.equal(body.rows[0].track_detection_method, 'queue_inferred');
  assert.equal(body.rows[0].track_confidence, 0.95);
  assert.equal(body.rows[0].quality_score, 0.98);
  assert.equal(body.rows[0].minute_at_iso, new Date(NOW - 60_000).toISOString());
});

test('stale or empty Pages data returns 503 while preserving available rows', async () => {
  const response = await latestMinuteFactsResponse(
    new Request('https://example.pages.dev/api/minute-facts/latest'),
    { MINUTE_FACT_API_STALE_MS: 300_000 },
    {
      now: () => NOW,
      readLatestMinuteFacts: async () => [fact({ minute_at: NOW - 301_000 })],
    },
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.stale, true);
  assert.equal(body.reason, 'latest-minute-fact-stale');
  assert.equal(body.rows.length, 1);

  const empty = buildLatestMinuteFactsPayload([], { now: NOW, staleAfterMs: 300_000 });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no-minute-facts');
});

test('Pages query failures and unsupported methods return bounded JSON errors', async () => {
  const failed = await latestMinuteFactsResponse(
    new Request('https://example.pages.dev/api/minute-facts/latest'),
    {},
    {
      now: () => NOW,
      readLatestMinuteFacts: async () => { throw new Error('D1 unavailable\nsecret detail'); },
    },
  );
  const failedBody = await failed.json();
  assert.equal(failed.status, 503);
  assert.equal(failedBody.query_ok, false);
  assert.equal(failedBody.reason, 'minute-facts-query-failed');
  assert.equal(failedBody.error, 'D1 unavailable secret detail');

  const post = await latestMinuteFactsResponse(
    new Request('https://example.pages.dev/api/minute-facts/latest', { method: 'POST' }),
    {},
  );
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
});

test('Pages route delegates through onRequest and owns the stale threshold', async () => {
  let prepared = 0;
  const response = await onRequest({
    request: new Request('https://example.pages.dev/api/minute-facts/latest'),
    env: {
      MINUTE_FACT_API_STALE_MS: 300_000,
      MINUTE_DB: {
        prepare() {
          prepared += 1;
          return { async all() { return { results: [fact({ minute_at: Date.now() })] }; } };
        },
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(prepared, 1);

  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars.MINUTE_FACT_API_STALE_MS, 300_000);
  assert.ok(config.d1_databases.some(({ binding }) => binding === 'MINUTE_DB'));
});
