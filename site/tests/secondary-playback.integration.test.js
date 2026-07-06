import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  onRequestGet as playbackGet,
  secondaryPlaybackPayload,
} from '../functions/api/playback.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

const migration = readFileSync(
  new URL('../../database/migrations/107_add_secondary_playback_current.sql', import.meta.url),
  'utf8',
);

function playbackRow(overrides = {}) {
  return {
    channel_alias: 'buddy46',
    station_id: 46,
    queue_id: 99,
    start_time: 300_000,
    is_paused: 0,
    is_broadcasting: 1,
    host_account_id: 9,
    host_handle: 'host46',
    state_hash: 'hash',
    checked_at: 340_000,
    changed_at: 300_000,
    queue_json: JSON.stringify([
      {
        position: 0,
        spotify_id: 'sp1',
        duration_ms: 180_000,
        title: 'Song 1',
        artist: 'Artist',
        thumbnail_url: 'cover-1',
      },
      {
        position: 1,
        spotify_id: 'sp2',
        duration_ms: 200_000,
        title: 'Song 2',
        artist: 'Artist',
        thumbnail_url: 'cover-2',
      },
    ]),
    ...overrides,
  };
}

test('secondary playback migration stores only one current row per channel', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sh_playback_channel_current/);
  assert.match(migration, /channel_alias TEXT PRIMARY KEY/);
  assert.match(migration, /queue_json TEXT NOT NULL/);
  assert.doesNotMatch(migration, /AUTOINCREMENT|history|snapshot/i);
});

test('secondary playback exposes current progress and upcoming tracks', () => {
  const payload = secondaryPlaybackPayload(playbackRow(), 350_000);

  assert.equal(payload.channel_alias, 'buddy46');
  assert.equal(payload.playing, true);
  assert.equal(payload.stale, false);
  assert.equal(payload.queue_status.current_index, 0);
  assert.equal(payload.queue_status.progress_ms, 50_000);
  assert.equal(payload.queue[0].is_current, true);
  assert.equal(payload.queue[1].title, 'Song 2');
});

test('paused secondary playback freezes progress at the playback change timestamp', () => {
  const payload = secondaryPlaybackPayload(playbackRow({
    is_paused: 1,
    changed_at: 330_000,
    checked_at: 890_000,
  }), 900_000);

  assert.equal(payload.playing, false);
  assert.equal(payload.queue_status.is_paused, true);
  assert.equal(payload.queue_status.current_index, 0);
  assert.equal(payload.queue_status.progress_ms, 30_000);
});

test('secondary playback does not report the last track as playing after queue end', () => {
  const payload = secondaryPlaybackPayload(playbackRow({
    start_time: 300_000,
    queue_json: JSON.stringify([{
      position: 0,
      spotify_id: 'sp1',
      duration_ms: 10_000,
      title: 'Short Song',
      artist: 'Artist',
    }]),
  }), 400_000);

  assert.equal(payload.playing, false);
  assert.equal(payload.queue_status.ended, true);
  assert.equal(payload.queue_status.current_index, -1);
  assert.equal(payload.queue[0].is_current, false);
});

test('corrupt current queue data is returned as stale instead of throwing', () => {
  const payload = secondaryPlaybackPayload(playbackRow({ queue_json: '{broken' }), 350_000);
  assert.equal(payload.stale, true);
  assert.equal(payload.queue_corrupt, true);
  assert.deepEqual(payload.queue, []);
});

test('missing secondary playback returns an empty stale feed', () => {
  const payload = secondaryPlaybackPayload(null, 350_000);
  assert.equal(payload.playing, false);
  assert.equal(payload.stale, true);
  assert.equal(payload.queue_status, null);
  assert.deepEqual(payload.queue, []);
});

test('secondary playback endpoint stays available before migration is applied', async () => {
  const db = new FakeD1Database().route(
    'first',
    'sh_playback_channel_current',
    () => { throw new Error('no such table: sh_playback_channel_current'); },
  );
  const response = await playbackGet({
    request: new Request('https://skrzk.test/api/playback?channel=buddy46'),
    env: { DB: db },
  });
  const body = await responseJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.channel_alias, 'buddy46');
  assert.equal(body.setup_required, true);
  assert.equal(body.stale, true);
  assert.deepEqual(body.queue, []);
});
