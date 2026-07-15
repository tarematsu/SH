import assert from 'node:assert/strict';
import test from 'node:test';

import {
  currentMinuteFactsRequest,
  onRequestGet as currentMinuteFacts,
} from '../functions/api/minute-facts/current.js';
import { onRequestGet as legacyCurrent } from '../functions/api/history-current.js';
import { onRequestGet as legacyMigrated } from '../functions/api/history-migrated.js';

function minuteDb() {
  return {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          assert.match(sql, /ORDER BY f\.minute_at DESC,f\.id DESC LIMIT \?/);
          return {
            results: [{
              id: 1,
              minute_at: 1_700_000_000_000,
              observed_at: 1_700_000_000_000,
              received_at: 1_700_000_000_000,
              source_code: 1,
              track_detection_code: 1,
              listener_count: 42,
            }],
          };
        },
        async first() {
          return {
            id: 1,
            source_code: 1,
            minute_at: 1_700_000_000_000,
            observed_at: 1_700_000_000_000,
            received_at: 1_700_000_000_000,
          };
        },
      };
    },
  };
}

test('current minute-facts route always requests the latest view', () => {
  const request = currentMinuteFactsRequest(
    new Request('https://example.com/api/minute-facts/current?latest=0&v=1'),
  );
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('latest'), '1');
  assert.equal(url.searchParams.get('v'), '1');
  assert.equal(request.method, 'GET');
});

test('canonical current route returns the latest minute facts response', async () => {
  const canonical = await currentMinuteFacts({
    request: new Request('https://example.com/api/minute-facts/current'),
    env: { MINUTE_DB: minuteDb() },
  });
  const body = await canonical.json();

  assert.equal(canonical.status, 200);
  assert.equal(body.mode, 'current');
  assert.equal(body.limit, 1440);
  assert.equal(body.rows.length, 1);
});

test('legacy minute-facts routes redirect to canonical URLs and preserve query parameters', async () => {
  const current = await legacyCurrent({
    request: new Request('https://example.com/api/history-current?latest=0&v=1'),
  });
  assert.equal(current.status, 308);
  assert.equal(current.headers.get('location'), '/api/minute-facts/current?latest=0&v=1');
  assert.equal(current.headers.get('deprecation'), 'true');
  assert.equal(current.headers.get('x-api-successor'), '/api/minute-facts/current');

  const migrated = await legacyMigrated({
    request: new Request('https://example.com/api/history-migrated?from=2026-07-01&limit=50'),
  });
  assert.equal(migrated.status, 308);
  assert.equal(migrated.headers.get('location'), '/api/minute-facts?from=2026-07-01&limit=50');
  assert.equal(migrated.headers.get('x-api-successor'), '/api/minute-facts');
});
