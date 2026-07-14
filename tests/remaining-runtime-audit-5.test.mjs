import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  refreshTrackMetadata,
  resetTrackMetadataRefreshState,
} from '../site/functions/api/track-metadata-refresh.js';
import {
  canonicalTrackLookupKey,
  createTrackLookupCachedFetch,
} from '../collector/fetch-cache.mjs';

test('empty metadata refreshes share one D1 query and reuse the empty result briefly', async () => {
  resetTrackMetadataRefreshState();
  let queries = 0;
  const env = {
    DB: {
      prepare() {
        return {
          async all() {
            queries += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { results: [] };
          },
        };
      },
    },
  };

  const [first, second] = await Promise.all([
    refreshTrackMetadata(env, 1000),
    refreshTrackMetadata(env, 1000),
  ]);
  assert.equal(queries, 1);
  assert.equal(first.done, true);
  assert.equal(second.done, true);

  const cached = await refreshTrackMetadata(env, Date.now());
  assert.equal(queries, 1);
  assert.equal(cached.cached, true);
});

test('local track lookup cache canonicalizes ids and clears after metadata writes', async () => {
  let calls = 0;
  const nativeFetch = async (input, init = {}) => {
    calls += 1;
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'POST') return Response.json({ ok: true });
    return Response.json({ ok: true, tracks: [{ spotify_id: 'a' }] });
  };
  const cachedFetch = createTrackLookupCachedFetch(nativeFetch, { ttlMs: 60_000, maxEntries: 4 });

  const firstUrl = 'https://example.test/api/ingest?type=track_lookup&ids=b,a';
  const secondUrl = 'https://example.test/api/ingest?type=track_lookup&ids=a,b';
  assert.equal(canonicalTrackLookupKey(firstUrl), canonicalTrackLookupKey(secondUrl));

  const first = await cachedFetch(firstUrl, { headers: { authorization: 'Bearer secret' } });
  const second = await cachedFetch(secondUrl, { headers: { authorization: 'Bearer secret' } });
  assert.deepEqual(await first.json(), await second.json());
  assert.equal(calls, 1);

  await cachedFetch('https://example.test/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'track_metadata', data: { tracks: [] } }),
  });
  await cachedFetch(firstUrl);
  assert.equal(calls, 3);
});

test('broadcast comparison reuses formatters and skips unchanged DOM writes', () => {
  const source = readFileSync(
    new URL('../site/public/history/history-broadcasts.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /const numberFormatter = new Intl\.NumberFormat/);
  assert.match(source, /const eventDateFormatter = new Intl\.DateTimeFormat/);
  assert.match(source, /function setTextIfChanged/);
  assert.match(source, /function setHtmlIfChanged/);
  assert.match(source, /broadcast-series:v3:/);
  assert.doesNotMatch(source, /toLocaleString\(/);
  assert.doesNotMatch(source, /toLocaleDateString\(/);
});

test('all local failover launch paths preload the track lookup cache', () => {
  const packageJson = JSON.parse(readFileSync(
    new URL('../collector/package.json', import.meta.url),
    'utf8',
  ));
  assert.match(packageJson.scripts['start:direct'], /--import=\.\/fetch-cache\.mjs/);
  assert.match(packageJson.scripts.once, /--import=\.\/fetch-cache\.mjs/);
  assert.match(packageJson.scripts.check, /fetch-cache\.mjs/);

  const supervisor = readFileSync(
    new URL('../collector/run-failover.mjs', import.meta.url),
    'utf8',
  );
  assert.match(supervisor, /spawn\(process\.execPath, \['--import=\.\/fetch-cache\.mjs', 'collector\.mjs'\]/);
  assert.match(supervisor, /COLLECTOR_MODE \|\| 'standby'/);
  assert.match(supervisor, /\['auto', 'active', 'standby'\]/);
});
