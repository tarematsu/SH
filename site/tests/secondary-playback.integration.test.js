import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { secondaryPlaybackPayload } from '../functions/api/playback.js';

const migration = readFileSync(
  new URL('../../database/migrations/107_add_secondary_playback_current.sql', import.meta.url),
  'utf8',
);

test('secondary playback migration stores only one current row per channel', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sh_playback_channel_current/);
  assert.match(migration, /channel_alias TEXT PRIMARY KEY/);
  assert.match(migration, /queue_json TEXT NOT NULL/);
  assert.doesNotMatch(migration, /AUTOINCREMENT|history|snapshot/i);
});

test('secondary playback exposes current progress and upcoming tracks', () => {
  const payload = secondaryPlaybackPayload({
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
  }, 350_000);

  assert.equal(payload.channel_alias, 'buddy46');
  assert.equal(payload.playing, true);
  assert.equal(payload.stale, false);
  assert.equal(payload.queue_status.current_index, 0);
  assert.equal(payload.queue_status.progress_ms, 50_000);
  assert.equal(payload.queue[0].is_current, true);
  assert.equal(payload.queue[1].title, 'Song 2');
});

test('missing secondary playback returns an empty stale feed', () => {
  const payload = secondaryPlaybackPayload(null, 350_000);
  assert.equal(payload.playing, false);
  assert.equal(payload.stale, true);
  assert.equal(payload.queue_status, null);
  assert.deepEqual(payload.queue, []);
});
