import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestGet as playbackGet } from '../functions/api/playback.js';
import { FakeD1Database, responseJson } from './helpers/fake-d1.js';

test('buddy playback falls back to the legacy current row before clock migration', async () => {
  const now = Date.now();
  const db = new FakeD1Database()
    .route('first', 'sh_collector_status', null)
    .route('first', (sql) => sql.includes('sh_buddy_playback_clock'), () => {
      throw new Error('no such table: sh_buddy_playback_clock');
    })
    .route('first', (sql) => sql.includes('FROM sh_playback_channel_current WHERE'), {
      channel_alias: 'buddy46',
      station_id: 46,
      queue_id: 99,
      start_time: now - 30_000,
      is_paused: 0,
      is_broadcasting: 1,
      host_account_id: 9,
      host_handle: 'host46',
      state_hash: 'legacy-hash',
      checked_at: now - 1_000,
      changed_at: now - 30_000,
      queue_json: JSON.stringify([{
        position: 0,
        spotify_id: 'sp1',
        duration_ms: 180_000,
        title: 'Legacy Song',
        artist: 'Legacy Artist',
        thumbnail_url: 'legacy-cover',
      }]),
    });

  const response = await playbackGet({
    request: new Request('https://skrzk.test/api/playback?channel=buddy46'),
    env: { OTHER_DB: db },
  });
  const payload = await responseJson(response);

  assert.equal(response.status, 200);
  assert.equal(payload.playing, true);
  assert.equal(payload.queue[0].title, 'Legacy Song');
  assert.equal(payload.queue[0].artist, 'Legacy Artist');
});
