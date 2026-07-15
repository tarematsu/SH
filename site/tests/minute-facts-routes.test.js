import assert from 'node:assert/strict';
import test from 'node:test';

import {
  currentMinuteFactsRequest,
  onRequestGet as currentMinuteFacts,
} from '../functions/api/minute-facts/current.js';
import { onRequestGet as legacyCurrent } from '../functions/api/history-current.js';

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

test('canonical and legacy current routes share the same implementation', async () => {
  const env = { MINUTE_DB: minuteDb() };
  const canonical = await currentMinuteFacts({
    request: new Request('https://example.com/api/minute-facts/current'),
    env,
  });
  const legacy = await legacyCurrent({
    request: new Request('https://example.com/api/history-current?latest=0'),
    env,
  });
  const canonicalBody = await canonical.json();
  const legacyBody = await legacy.json();

  assert.equal(canonical.status, 200);
  assert.equal(legacy.status, 200);
  assert.equal(canonicalBody.mode, 'current');
  assert.equal(canonicalBody.limit, 1440);
  assert.deepEqual(legacyBody, canonicalBody);
});
