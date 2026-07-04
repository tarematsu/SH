import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestGet } from '../functions/api/stationhead-weekly-leaderboard-test.js';

function sessionDatabase(row) {
  return {
    prepare(sql) {
      assert.match(sql, /FROM sh_worker_collector_state/);
      return {
        async first() {
          return row;
        },
      };
    },
  };
}

test('weekly leaderboard diagnostic uses the stored authenticated session without exposing it', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamRequest;
  globalThis.fetch = async (url, options) => {
    upstreamRequest = { url: String(url), options };
    return new Response(JSON.stringify({ accounts: [{ id: 1, handle: 'buddies' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const response = await onRequestGet({
      env: {
        DB: sessionDatabase({
          auth_token: 'stored-token',
          device_uid: 'stored-device',
        }),
        STATIONHEAD_APP_VERSION: '2026.test',
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(upstreamRequest.url, 'https://production1.stationhead.com/weeklyLeaderboard');
    assert.equal(upstreamRequest.options.headers.Authorization, 'Bearer stored-token');
    assert.equal(upstreamRequest.options.headers['sth-device-uid'], 'stored-device');
    assert.equal(upstreamRequest.options.headers['App-Version'], '2026.test');
    assert.deepEqual(body.authentication, {
      source: 'd1',
      bearerTokenPresent: true,
      deviceUidPresent: true,
    });
    assert.equal(body.request.headers.Authorization, 'Bearer [redacted]');
    assert.equal(body.request.headers['sth-device-uid'], '[redacted]');
    assert.doesNotMatch(JSON.stringify(body), /stored-token|stored-device/);
    assert.equal(body.response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('weekly leaderboard diagnostic stops before the upstream request when no session exists', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('unexpected fetch');
  };

  try {
    const response = await onRequestGet({ env: { DB: sessionDatabase(null) } });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(fetchCalled, false);
    assert.equal(body.ok, false);
    assert.equal(body.error.type, 'configuration');
    assert.match(body.error.message, /authenticated session is unavailable/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
