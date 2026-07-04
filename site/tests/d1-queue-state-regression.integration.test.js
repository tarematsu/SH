import assert from 'node:assert/strict';
import test from 'node:test';

import { saveLeanQueue } from '../functions/lib/d1-optimized-ingest.js';
import { queueRevision } from '../functions/lib/queue-state.js';
import { FakeD1Database } from './helpers/fake-d1.js';

test('queue revision changes when only current likes change', () => {
  const base = {
    station_id: 1,
    queue_id: 2,
    start_time: 3,
    is_paused: 0,
    structural_hash: 'structure-a',
    item_observed_at: 10,
    metadata_fetched_at: 20,
    total_items: 2,
  };
  const first = queueRevision({ ...base, likes_hash: 'likes-a' }, 'id:9');
  const second = queueRevision({ ...base, likes_hash: 'likes-b' }, 'id:9');
  assert.notEqual(first, second);
});

test('structural queue changes prune removed items and stale current likes', async () => {
  const db = new FakeD1Database();
  const result = await saveLeanQueue(db, 1_751_500_500_000, {
    type: 'queue',
    collector_id: 'integration-collector',
    data: {
      station_id: 3328626,
      queue_id: 91,
      start_time: 1_751_500_000_000,
      is_paused: false,
      tracks: [{
        position: 0,
        queue_track_id: 100,
        spotify_id: 'spotify-1',
        duration_ms: 180_000,
        bite_count: 12,
      }],
    },
  });

  assert.equal(result.structureChanged, true);
  assert.equal(db.callsMatching(/DELETE FROM sh_queue_items/, 'run').length, 1);
  assert.equal(db.callsMatching(/DELETE FROM sh_track_like_current/, 'run').length, 1);
});
