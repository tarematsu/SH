import test from 'node:test';
import assert from 'node:assert/strict';

import { createPublicHealthCachedApp, sanitizePublicHealth } from '../src/public-health-cache.js';

test('sanitizePublicHealth removes internal errors and identifiers', () => {
  assert.deepEqual(sanitizePublicHealth({
    ok: true,
    last_success_at: 123,
    last_error: 'secret failure',
    official_news_last_error: 'news failure',
    cloud_host_last_error: 'browser failure',
    collector_health_error: 'D1 failure',
    token_expires_at: 999,
    auth_token_expires_at: 999,
    browser_token_expires_at: 999,
    channel_id: 1,
    station_id: 2,
    cloud_solo_session_id: 3,
    cloud_solo_station_id: 4,
  }), {
    ok: true,
    last_success_at: 123,
  });
});

test('repeated health requests reuse a completed detached response', async () => {
  let calls = 0;
  let now = 1_000;
  const app = {
    async fetch() {
      calls += 1;
      return Response.json({ ok: true, last_success_at: 123, last_error: 'hidden' });
    },
    async scheduled() {},
  };
  const cached = createPublicHealthCachedApp(app, () => now);
  const request = new Request('https://example.test/health');

  const first = await cached.fetch(request, { PUBLIC_HEALTH_CACHE_MS: 60_000 }, {});
  const second = await cached.fetch(request, { PUBLIC_HEALTH_CACHE_MS: 60_000 }, {});

  assert.equal(calls, 1);
  assert.equal(first.headers.get('x-health-cache'), 'miss');
  assert.equal(second.headers.get('x-health-cache'), 'hit');
  assert.deepEqual(await second.json(), { ok: true, last_success_at: 123 });

  now += 60_001;
  await cached.fetch(request, { PUBLIC_HEALTH_CACHE_MS: 60_000 }, {});
  assert.equal(calls, 2);
});

test('concurrent health requests never share request-scoped upstream I/O', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = {
    async fetch() {
      calls += 1;
      await gate;
      return Response.json({ ok: true, call: calls });
    },
    async scheduled() {},
  };
  const cached = createPublicHealthCachedApp(app, () => 1_000);
  const request = new Request('https://example.test/health');

  const first = cached.fetch(request, {}, {});
  const second = cached.fetch(request, {}, {});
  await Promise.resolve();
  assert.equal(calls, 2);
  release();
  await Promise.all([first, second]);
});

test('invalidation prevents an older in-flight health read from repopulating the cache', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = {
    async fetch(request) {
      if (request.method !== 'GET') return Response.json({ ok: true });
      calls += 1;
      if (calls === 1) await gate;
      return Response.json({ ok: true, generation: calls });
    },
    async scheduled() {},
  };
  const cached = createPublicHealthCachedApp(app, () => 1_000);
  const health = new Request('https://example.test/health');

  const staleRead = cached.fetch(health, {}, {});
  await Promise.resolve();
  await cached.scheduled({}, {}, {});
  release();
  await staleRead;
  const fresh = await cached.fetch(health, {}, {});

  assert.equal(calls, 2);
  assert.equal((await fresh.json()).generation, 2);
});

test('non-JSON health responses are returned without a duplicate upstream read', async () => {
  let calls = 0;
  const app = {
    async fetch() {
      calls += 1;
      return new Response('temporarily unavailable', { status: 503 });
    },
    async scheduled() {},
  };
  const cached = createPublicHealthCachedApp(app);
  const response = await cached.fetch(new Request('https://example.test/health'), {}, {});

  assert.equal(calls, 1);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'temporarily unavailable');
});

test('failed health responses explicitly disable downstream caching', async () => {
  const app = {
    async fetch() { return Response.json({ ok: false }, { status: 503 }); },
    async scheduled() {},
  };
  const cached = createPublicHealthCachedApp(app);
  const response = await cached.fetch(new Request('https://example.test/health'), {}, {});

  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('successful mutation and scheduled run invalidate health cache', async () => {
  let healthCalls = 0;
  const app = {
    async fetch(request) {
      if (request.method === 'GET') {
        healthCalls += 1;
        return Response.json({ ok: true, generation: healthCalls });
      }
      return Response.json({ ok: true });
    },
    async scheduled() {},
  };
  const cached = createPublicHealthCachedApp(app, () => 1_000);
  const health = new Request('https://example.test/health');

  await cached.fetch(health, {}, {});
  await cached.fetch(health, {}, {});
  assert.equal(healthCalls, 1);

  await cached.fetch(new Request('https://example.test/run', { method: 'POST' }), {}, {});
  await cached.fetch(health, {}, {});
  assert.equal(healthCalls, 2);

  await cached.scheduled({ cron: '* * * * *' }, {}, {});
  await cached.fetch(health, {}, {});
  assert.equal(healthCalls, 3);
});
