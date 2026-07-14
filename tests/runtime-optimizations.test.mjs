import test from 'node:test';
import assert from 'node:assert/strict';

import { requestWithParsedJson } from '../site/functions/api/ingest.js';
import { AUTH_STATE_SQL, parseAuthState, readAuthState } from '../worker/src/auth-state.js';
import { runCollection } from '../worker/src/index.js';

test('parsed ingest requests reuse one JSON body for the legacy handler', async () => {
  const request = new Request('https://example.test/api/ingest', {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'snapshot', data: { listener_count: 10 } }),
  });
  const body = await request.json();
  const wrapped = requestWithParsedJson(request, body);

  assert.deepEqual(await wrapped.json(), body);
  assert.deepEqual(await wrapped.json(), body);
  assert.equal(wrapped.method, 'POST');
  assert.equal(wrapped.headers.get('authorization'), 'Bearer secret');
});

test('concurrent collection triggers remain request-scoped', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const collector = async (_env, source) => {
    calls += 1;
    await gate;
    return { ok: true, source };
  };

  const first = runCollection({}, 'cron', collector);
  const second = runCollection({}, 'http', collector);
  assert.notStrictEqual(first, second);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 2);
  release();
  assert.deepEqual(await first, { ok: true, source: 'cron' });
  assert.deepEqual(await second, { ok: true, source: 'http' });
});

test('collection runner accepts a new invocation after failure', async () => {
  let calls = 0;
  await assert.rejects(() => runCollection({}, 'first', async () => {
    calls += 1;
    throw new Error('temporary');
  }));
  const result = await runCollection({}, 'second', async () => {
    calls += 1;
    return { ok: true };
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('auth state loads session and lock control in one D1 query', async () => {
  let prepareCalls = 0;
  let boundId = null;
  const env = {
    DB: {
      prepare(sql) {
        prepareCalls += 1;
        assert.equal(sql, AUTH_STATE_SQL);
        return {
          bind(id) {
            boundId = id;
            return this;
          },
          async first() {
            return {
              auth_token: 'stored-token',
              device_uid: 'device-1',
              token_expires_at: 123,
              control_id: 'stationhead',
              last_attempt_at: 10,
              last_success_at: 20,
              last_error: null,
              lock_until: 30,
            };
          },
        };
      },
    },
  };

  const state = await readAuthState(env);
  assert.equal(prepareCalls, 1);
  assert.equal(boundId, 'stationhead');
  assert.equal(state.authToken, 'stored-token');
  assert.equal(state.deviceUid, 'device-1');
  assert.equal(state.controlExists, true);
  assert.equal(state.lockUntil, 30);
});

test('auth state falls back to Worker secrets without creating a control row', () => {
  const state = parseAuthState(null, {
    STATIONHEAD_AUTH_TOKEN: 'Bearer fallback-token',
    STATIONHEAD_DEVICE_UID: 'fallback-device',
  });
  assert.equal(state.authToken, 'fallback-token');
  assert.equal(state.deviceUid, 'fallback-device');
  assert.equal(state.controlExists, false);
});
