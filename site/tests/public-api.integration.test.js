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

const PLAYBACK_CORE_FIELDS = [
  'ok',
  'channel_alias',
  'generated_at',
  'latest_observed_at',
  'queue_observed_at',
  'changed_at',
  'station_id',
  'is_broadcasting',
  'host_account_id',
  'host_handle',
  'playing',
  'stale',
  'setup_required',
  'queue_revision',
  'queue_status',
  'queue',
];

function assertPlaybackCoreEnvelope(payload) {
  for (const field of PLAYBACK_CORE_FIELDS) assert.ok(field in payload, `missing playback field: ${field}`);
}

test('playback endpoint rejects a missing D1 binding without cacheable output', async () => {
  const response = await playbackGet({ env: {} });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await responseJson(response), { ok: false, error: 'MINUTE_DB binding missing' });
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
  const db = new FakeD1Database()
    .route('first', 'FROM sh_minute_facts f', {
      observed_at: now - 1_000,
      channel_id: 318,
      station_id: 3328626,
      is_broadcasting: 1,
      host_account_id: 46,
      host_handle: 'sakurazaka46jp',
      broadcast_start_time: now - 600_000,
    })
    .route('first', 'FROM sh_queue_read_model_current', {
      channel_id: 318,
      observed_at: now - 500,
      station_id: 3328626,
      queue_id: 91,
      start_time: now - 30_000,
      is_paused: 0,
      queue_json: JSON.stringify(rows.map((row) => ({
        ...row,
        station_id: row.queue_station_id,
        start_time: row.queue_start_time,
      }))),
    });
  const response = await playbackGet({ env: { MINUTE_DB: db } });
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

test('buddies and buddy46 expose the same core playback envelope when empty', async () => {
  const primaryResponse = await playbackGet({
    request: new Request('https://skrzk.test/api/playback?channel=buddies'),
    env: { MINUTE_DB: new FakeD1Database().route('first', 'FROM sh_minute_facts f', null) },
  });
  const secondaryDb = new FakeD1Database()
    .route('first', 'sh_collector_status', null)
    .route('first', 'sh_playback_channel_current', null);
  const secondaryResponse = await playbackGet({
    request: new Request('https://skrzk.test/api/playback?channel=buddy46'),
    env: { OTHER_DB: secondaryDb },
  });
  const primary = await responseJson(primaryResponse);
  const secondary = await responseJson(secondaryResponse);

  assert.equal(primaryResponse.status, 200);
  assert.equal(secondaryResponse.status, 200);
  assertPlaybackCoreEnvelope(primary);
  assertPlaybackCoreEnvelope(secondary);
  assert.equal(primary.host_account_id, null);
  assert.equal(primary.host_handle, null);
  assert.equal(secondary.host_account_id, null);
  assert.equal(secondary.host_handle, null);
  assert.deepEqual(primary.queue, []);
  assert.deepEqual(secondary.queue, []);
  assert.equal('collector' in primary, false);
  assert.equal(secondary.collector.status, 'never');
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
  const db = new FakeD1Database().route('all', 'WITH eligible AS', {
    results: [{ event_name: null, has_data: 0 }],
  });
  const response = await historyGet({
    request: new Request('https://skrzk.test/api/history?mode=broadcasts&from=2026-01-01&to=2026-01-02'),
    env: { DB: new FakeD1Database(), OTHER_DB: db },
  });
  const body = await responseJson(response);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'broadcasts');
  assert.equal(body.setup_required, true);
  assert.deepEqual(body.rows, []);
});

test('history endpoint restores the ranking leaderboard from OTHER_DB', async () => {
  resetHistoryLoadCache();
  const otherDb = new FakeD1Database()
    .route('all', /FROM sh_channel_rankings r/, {
      results: [{
        ranking_date: '2026-07-07',
        observed_at: Date.parse('2026-07-07T00:00:00Z'),
        ranking_type: '週間リーダーボード',
        rank: 3,
        host_name: 'sakuramankai',
        host_alias: '櫻坂46',
        source_sheet: 'weekly',
        quality_score: 1,
        quality_flags: null,
      }],
    })
    .route('all', /SELECT DISTINCT ranking_date/, {
      results: [{ ranking_date: '2026-07-07' }, { ranking_date: '2026-07-14' }],
    });
  const response = await historyGet({
    request: new Request('https://skrzk.test/api/history?mode=ranking&from=2026-07-01&to=2026-07-31'),
    env: {
      DB: new FakeD1Database(),
      OTHER_DB: otherDb,
    },
  });
  const body = await responseJson(response);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'ranking');
  assert.deepEqual(body.ranking_weeks, ['2026-07-07', '2026-07-14']);
  assert.equal(body.rows[0].ranking_date, '2026-07-14');
  assert.equal(body.rows[0].rank, null);
  assert.equal(body.rows[0].is_out_of_rank, true);
  assert.equal(body.rows.find((row) => row.ranking_date === '2026-07-07' && row.host_name === 'sakuramankai').rank, 3);
  assert.ok(otherDb.callsMatching(/FROM sh_channel_rankings/).length >= 2);
});

test('history rejects impossible dates before querying D1', async () => {
  const env = {
      DB: {
        prepare() { throw new Error('D1 should not be queried'); },
      },
      OTHER_DB: {
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
      OTHER_DB: {
        prepare() { throw new Error('D1 should not be queried'); },
      },
      MINUTE_DB: {
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
      OTHER_DB: {
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
