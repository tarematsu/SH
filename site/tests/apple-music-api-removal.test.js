import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUEUE_ITEMS_FOR_STATE_SQL,
  queueItemsFromRows,
} from '../functions/lib/queue-state.js';
import { mergeTrackRows } from '../functions/lib/track-history-merge.js';

test('queue state neither selects nor returns Apple Music IDs', () => {
  assert.doesNotMatch(QUEUE_ITEMS_FOR_STATE_SQL, /apple[_-]?music/i);
  const rows = queueItemsFromRows([{
    item_observed_at: 10,
    position: 0,
    spotify_id: 'spotify-track',
    apple_music_id: 'legacy-apple-track',
    title: 'Song',
  }], {
    station_id: 1,
    queue_id: 2,
    start_time: 3,
  });
  assert.equal(rows[0].spotify_id, 'spotify-track');
  assert.equal('apple_music_id' in rows[0], false);
});

test('track history does not merge or emit rows by Apple Music identity', () => {
  const rows = mergeTrackRows([
    {
      play_date: '2026-07-19',
      title: 'First Song',
      artist: 'First Artist',
      apple_music_id: 'shared-legacy-id',
      play_count: 1,
    },
    {
      play_date: '2026-07-19',
      title: 'Second Song',
      artist: 'Second Artist',
      apple_music_id: 'shared-legacy-id',
      play_count: 1,
    },
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => !('apple_music_id' in row)));
  assert.ok(rows.every((row) => !row.source_keys.some((key) => key.startsWith('apple:'))));
});
