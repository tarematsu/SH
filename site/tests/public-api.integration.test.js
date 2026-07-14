import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendJsonObjectFields,
  cachedPrediction,
  decorateQueueResponse,
  resetPredictionCache,
  selectGoalPrediction,
} from '../functions/api/dashboard.js';
import {
  cachedHistoryLoad,
  onRequestGet as historyGet,
  resetHistoryLoadCache,
} from '../functions/api/history.js';
import { onRequestGet as playbackGet } from '../functions/api/playback.js';
import { onRequestGet as broadcastSeriesGet } from '../functions/api/broadcast-series.js';
import { onRequestGet as officialHistoryGet } from '../functions/api/official-history.js';
import { onRequestGet as trackLikesGet } from '../functions/api/track-likes.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

test('playback endpoint rejects a missing D1 binding without cacheable output', async () => {
  const response = await playbackGet({ env: {} });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await responseJson(response), { ok: false, error: 'DB binding missing' });
});

test('playback endpoint maps a live queue into current-track state and cache headers', async () => {
  const now = Date.now();
  const rows = [{
    channel_observed_at: now - 1_000,
    channel_station_id: 3328626,
    is_broadcasting: 1,
    host_account_id: 46,
    host_handle: 'sakurazaka46jp',
    broadcast_start_time: now - 600_000,
    queue_station_id: 3328626,
    queue_id: 91,
    queue_start_time: now - 30_000,
    queue_is_paused: 0,
    queue_observed_at: now - 500,
    item_observed_at: now - 500,
    position: 0,
    queue_track_id: 1001,
    stationhead_track_id: 2001,
    spotify_id: 'spotify-track-1',
    deezer_id: null,
    isrc: 'JPTEST000001',
    duration_ms: 180_000,
    preview_url: null,
    bite_count: 12,
    title: 'Integration Song',
    artist: 'Integration Artist',
    display_title: 'Integration Song - Integration Artist',
    thumbnail_url: 'https://example.invalid/cover.jpg',
    spotify_url: null,
    metadata_fetched_at: now - 2_000,
    metadata_raw_json: null,
  }];
  const db = new FakeD1Database().route('all', 'WITH latest_channel AS', { results: rows });
  const response = await playbackGet({ env: { DB: db } });
  const body = await responseJson(response);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=5, s-maxage=10, stale-while-revalidate=30');
  assert.equal(body.ok, true);
  assert.equal(body.station_id, 3328626);
  assert.equal(body.playing, true);
  assert.equal(body.queue_status.total_items, 1);
  assert.equal(body.queue_status.current_index, 0);
  assert.equal(body.queue[0].is_current, true);
  assert.equal(body.queue[0].title, 'Integration Song');
  assert.equal(body.queue[0].artist, 'Integration Artist');
  assert.equal('apple_music_id' in body.queue[0], false);
  assert.match(body.queue_revision, /^[a-z0-9_-]+/i);
});

test('history endpoint rejects unknown modes and never caches errors', async () => {
  const response = await historyGet({
    request: new Request('https://skrzk.test/api/history?mode=unknown'),
    env: { DB: new FakeD1Database() },
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: 'unsupported history mode: unknown',
  });
});

test('broadcast history reports setup-required only when no imported event exists', async () => {
  resetHistoryLoadCache();
  const db = new FakeD1Database().route('all', 'WITH summaries AS', {
    results: [{ event_name: null, has_data: 0 }],
  });
  const response = await historyGet({
    request: new Request('https://skrzk.test/api/history?mode=broadcasts&from=2026-01-01&to=2026-01-02'),
    env: { DB: db },
  });
  const body = await responseJson(response);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'broadcasts');
  assert.equal(body.setup_required, true);
  assert.deepEqual(body.rows, []);
});

test('history rejects impossible dates before querying D1', async () => {
  const env = {
    DB: {
      prepare() { throw new Error('D1 should not be queried'); },
    },
  };
  const response = await historyGet({
    request: new Request('https://skrzk.test/api/history?mode=broadcasts&from=2026-02-30&to=2026-03-01'),
    env,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: 'from and to must be valid YYYY-MM-DD dates',
  });
});

test('broadcast series rejects impossible dates before querying D1', async () => {
  const env = {
    DB: {
      prepare() { throw new Error('D1 should not be queried'); },
    },
  };
  const response = await broadcastSeriesGet({
    request: new Request('https://skrzk.test/api/broadcast-series?from=2026-02-30&to=2026-03-01'),
    env,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: 'from and to must be valid YYYY-MM-DD dates',
  });
});

test('official history rejects impossible dates before querying D1', async () => {
  const env = {
    DB: {
      prepare() { throw new Error('D1 should not be queried'); },
    },
  };
  const response = await officialHistoryGet({
    request: new Request('https://skrzk.test/api/official-history?from=2026-02-30&to=2026-03-01'),
    env,
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: 'from and to must be valid YYYY-MM-DD dates',
  });
});

test('track likes rejects impossible dates before querying D1', async () => {
  const env = {
    DB: {
      prepare() { throw new Error('D1 should not be queried'); },
    },
  };
  const response = await trackLikesGet({
    request: new Request('https://skrzk.test/api/track-likes?from=2026-02-30&to=2026-03-01'),
    env,
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: 'from and to must be valid YYYY-MM-DD dates',
  });
});

test('history cache coalesces concurrent readers and can be reset safely', async () => {
  resetHistoryLoadCache();
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loader = async () => {
    loads += 1;
    await gate;
    return { value: 42 };
  };
  const first = cachedHistoryLoad('integration:key', 60_000, loader, 100);
  const second = cachedHistoryLoad('integration:key', 60_000, loader, 100);
  release();
  assert.deepEqual(await first, { value: 42 });
  assert.deepEqual(await second, { value: 42 });
  assert.equal(loads, 1);
  resetHistoryLoadCache();
});

test('dashboard prediction cache retains completed values without sharing request-scoped D1 promises', async () => {
  resetPredictionCache();
  let reads = 0;
  const statement = {
    async first() {
      reads += 1;
      await Promise.resolve();
      return { slope: 2, intercept: 10 };
    },
  };
  const [first, second] = await Promise.all([
    cachedPrediction(statement, 100),
    cachedPrediction(statement, 100),
  ]);
  assert.deepEqual(first, second);
  assert.equal(reads, 2);

  const decorated = decorateQueueResponse({
    ok: true,
    latest: { is_broadcasting: 1 },
    queue: [{ position: 0 }],
    queue_status: { is_paused: false, total_items: 1 },
  }, {
    revision: 'rev-1',
    unchanged: true,
    state: { total_items: 3 },
  });
  assert.equal(decorated.queue_revision, 'rev-1');
  assert.equal(decorated.queue_unchanged, true);
  assert.deepEqual(decorated.queue, []);
  assert.equal(decorated.queue_status.playing, true);
  assert.equal(decorated.queue_status.total_items, 3);

  const appended = appendJsonObjectFields('{"ok":true}', { queue_revision: 'rev-2' });
  assert.deepEqual(JSON.parse(appended), { ok: true, queue_revision: 'rev-2' });
  resetPredictionCache();
});

test('dashboard keeps calculated goal prediction when persisted state is unavailable', () => {
  const calculated = {
    eta: 1783400000000,
    rate_per_hour: 12000,
    remaining: 100000,
    sample_count: 80,
    span_hours: 12,
  };
  assert.equal(selectGoalPrediction(null, calculated, 53240000), calculated);
});

test('dashboard prefers valid persisted goal prediction over calculated fallback', () => {
  const calculated = { eta: 1783400000000, rate_per_hour: 12000, remaining: 100000 };
  const persisted = selectGoalPrediction({
    generated_at: 1783300000000,
    goal: 53240000,
    eta: 1783500000000,
    rate_per_hour: 15000,
    remaining: 90000,
  }, calculated, 53240000);
  assert.notEqual(persisted, calculated);
  assert.equal(persisted.rate_per_hour, 15000);
});
