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
      headers: {
        authorization: 'Bearer rotated-token',
        'developer-token': 'developer-secret',
        pusher: 'pusher-secret',
        'set-cookie': 'session=secret',
        'content-type': 'application/json',
        'x-cache': 'Miss from cloudfront',
      },
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
    assert.equal(body.response.headers['content-type'], 'application/json');
    assert.equal(body.response.headers['x-cache'], 'Miss from cloudfront');
    assert.equal(body.response.headers.authorization, undefined);
    assert.equal(body.response.headers['developer-token'], undefined);
    assert.equal(body.response.headers.pusher, undefined);
    assert.equal(body.response.headers['set-cookie'], undefined);
    assert.doesNotMatch(
      JSON.stringify(body),
      /stored-token|stored-device|rotated-token|developer-secret|pusher-secret|session=secret/,
    );
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

test('weekly leaderboard diagnostic falls back to environment credentials when D1 has no session', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamHeaders;
  globalThis.fetch = async (_url, options) => {
    upstreamHeaders = options.headers;
    return new Response(JSON.stringify({ accounts: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const response = await onRequestGet({
      env: {
        DB: sessionDatabase(null),
        STATIONHEAD_AUTH_TOKEN: 'Bearer env-token',
        STATIONHEAD_DEVICE_UID: 'env-device',
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(upstreamHeaders.Authorization, 'Bearer env-token');
    assert.equal(upstreamHeaders['sth-device-uid'], 'env-device');
    assert.equal(body.authentication.source, 'environment');
    assert.doesNotMatch(JSON.stringify(body), /env-token|env-device/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
