import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRequestHardenedApp,
  isMondayWeekStart,
  isRealIsoDate,
} from '../src/request-hardening.js';

test('isRealIsoDate rejects impossible calendar dates', () => {
  assert.equal(isRealIsoDate('2026-07-05'), true);
  assert.equal(isRealIsoDate('2024-02-29'), true);
  assert.equal(isRealIsoDate('2026-02-29'), false);
  assert.equal(isRealIsoDate('2026-02-31'), false);
  assert.equal(isRealIsoDate('2026-99-99'), false);
});

test('weekly recap keys must be real Mondays', () => {
  assert.equal(isMondayWeekStart('2026-07-06'), true);
  assert.equal(isMondayWeekStart('2026-07-05'), false);
  assert.equal(isMondayWeekStart('2026-02-30'), false);
});

test('invalid email recap date is rejected before D1 work', async () => {
  let calls = 0;
  const app = {
    async fetch() {
      calls += 1;
      return Response.json({ ok: true });
    },
    async scheduled() {},
  };
  const hardened = createRequestHardenedApp(app);
  const response = await hardened.fetch(new Request('https://example.test/ingest/email-recap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ week_of: '2026-02-31' }),
  }), {}, {});
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('non-Monday email recap date is rejected before D1 work', async () => {
  let calls = 0;
  const app = {
    async fetch() {
      calls += 1;
      return Response.json({ ok: true });
    },
    async scheduled() {},
  };
  const hardened = createRequestHardenedApp(app);
  const response = await hardened.fetch(new Request('https://example.test/ingest/email-recap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ week_of: '2026-07-05' }),
  }), {}, {});
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('successful identical email recap retries reuse stored response', async () => {
  let calls = 0;
  const app = {
    async fetch() {
      calls += 1;
      return Response.json({ ok: true, imported: true });
    },
    async scheduled() {},
  };
  const hardened = createRequestHardenedApp(app, () => 1000);
  const makeRequest = () => new Request('https://example.test/ingest/email-recap', {
    method: 'POST',
    headers: {
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ week_of: '2026-07-06', stream_count: 123 }),
  });

  const first = await hardened.fetch(makeRequest(), {}, {});
  const second = await hardened.fetch(makeRequest(), {}, {});
  assert.equal(calls, 1);
  assert.equal(first.headers.get('x-idempotent-replay'), null);
  assert.equal(second.headers.get('x-idempotent-replay'), '1');
  assert.deepEqual(await second.json(), { ok: true, imported: true });
});

test('coordination lease details require an internal bearer token', async () => {
  let calls = 0;
  const app = {
    async fetch() {
      calls += 1;
      return Response.json({ ok: true, holder_id: 'cloudflare-worker' });
    },
    async scheduled() {},
  };
  const hardened = createRequestHardenedApp(app);
  const unauthorized = await hardened.fetch(
    new Request('https://example.test/coordination/lease'),
    { EMAIL_RECAP_SECRET: 'secret' },
    {},
  );
  const authorized = await hardened.fetch(
    new Request('https://example.test/coordination/lease', {
      headers: { authorization: 'Bearer secret' },
    }),
    { EMAIL_RECAP_SECRET: 'secret' },
    {},
  );

  assert.equal(unauthorized.status, 401);
  assert.equal(authorized.status, 200);
  assert.equal(calls, 1);
});

test('POST run hides upstream failure details', async () => {
  const app = {
    async fetch() {
      return Response.json({ ok: false, error: 'Stationhead API response body secret' }, { status: 500 });
    },
    async scheduled() {},
  };
  const hardened = createRequestHardenedApp(app);
  const response = await hardened.fetch(new Request('https://example.test/run', { method: 'POST' }), {}, {});
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: 'collection failed' });
});
