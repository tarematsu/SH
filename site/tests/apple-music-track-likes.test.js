import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TRACK_LIKE_HISTORY_SQL,
  TRACK_LIKE_QUEUE_SQL,
  TRACK_LIKE_REALTIME_SQL,
  compactTrackLikeSources,
} from '../functions/lib/track-likes.js';

test('track-like SQL does not select Apple Music columns', () => {
  assert.doesNotMatch(TRACK_LIKE_REALTIME_SQL, /apple_music_id/i);
  assert.doesNotMatch(TRACK_LIKE_QUEUE_SQL, /apple_music_id/i);
  assert.doesNotMatch(TRACK_LIKE_HISTORY_SQL, /apple_music_id/i);
  assert.match(TRACK_LIKE_REALTIME_SQL, /spotify_id,isrc/);
  assert.match(TRACK_LIKE_QUEUE_SQL, /q\.spotify_id,q\.isrc/);
});

test('track-like compaction removes Apple Music fields from compatibility rows', () => {
  const [row] = compactTrackLikeSources([[
    {
      play_date: '2026-07-19',
      spotify_id: 'spotify-track',
      apple_music_id: 'legacy-apple-track',
      like_count: 4,
      observed_at: 100,
    },
  ]]);
  assert.equal(row.spotify_id, 'spotify-track');
  assert.equal('apple_music_id' in row, false);
});
