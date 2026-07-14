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

test('repeated health requests share one upstream read', async () => {
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
