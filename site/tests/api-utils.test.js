import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bool,
  ingestAccessError,
  observedAtFrom,
  readJsonBody,
} from '../functions/lib/api-utils.js';

function request(body, headers = {}) {
  return new Request('https://skrzk.test/api/test', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body,
  });
}

test('readJsonBody parses JSON and reports invalid JSON without throwing', async () => {
  const valid = await readJsonBody(request('{"ok":true}'));
  const invalid = await readJsonBody(request('{broken'));

  assert.equal(valid.ok, true);
  assert.deepEqual(valid.body, { ok: true });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.error instanceof Error);
});

test('readJsonBody clone option preserves the original request body', async () => {
  const original = request('{"type":"snapshot"}');
  const parsed = await readJsonBody(original, { clone: true });
  const reparsed = await original.json();

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.body, { type: 'snapshot' });
  assert.deepEqual(reparsed, { type: 'snapshot' });
});

test('observedAtFrom uses numeric observed_at or a fallback', () => {
  assert.equal(observedAtFrom({ observed_at: '1234' }, 999), 1234);
  assert.equal(observedAtFrom({ observed_at: 'not-a-number' }, 999), 999);
  assert.equal(observedAtFrom({}, 999), 999);
});

test('observedAtFrom does not evaluate the clock when observed_at is valid', () => {
  const originalNow = Date.now;
  let calls = 0;
  Date.now = () => {
    calls += 1;
    return 777;
  };
  try {
    assert.equal(observedAtFrom({ observed_at: 1234 }), 1234);
    assert.equal(calls, 0);
    assert.equal(observedAtFrom({}), 777);
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
  }
});

test('bool parses known representations and rejects unknown encodings', () => {
  assert.equal(bool(true), 1);
  assert.equal(bool(false), 0);
  assert.equal(bool('true'), 1);
  assert.equal(bool('FALSE'), 0);
  assert.equal(bool('1'), 1);
  assert.equal(bool('0'), 0);
  assert.equal(bool('yes'), 1);
  assert.equal(bool('off'), 0);
  assert.equal(bool('unknown'), null);
  assert.equal(bool('null'), null);
  assert.equal(bool(Number.NaN), null);
  assert.equal(bool({}), null);
  assert.equal(bool(null), null);
});

test('ingestAccessError distinguishes auth and DB failures', async () => {
  const unauthorized = ingestAccessError(request('{}'), { INGEST_SECRET: 'secret', DB: {} });
  const missingDb = ingestAccessError(request('{}', { authorization: 'Bearer secret' }), { INGEST_SECRET: 'secret' });
  const accepted = ingestAccessError(request('{}', { authorization: 'Bearer secret' }), { INGEST_SECRET: 'secret', DB: {} });

  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { ok: false, error: 'unauthorized' });
  assert.equal(missingDb.status, 500);
  assert.deepEqual(await missingDb.json(), { ok: false, error: 'DB binding missing' });
  assert.equal(accepted, null);
});
