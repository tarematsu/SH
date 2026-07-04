import assert from 'node:assert/strict';
import test from 'node:test';

import { saveLeanQueue } from '../functions/lib/d1-optimized-ingest.js';
import { FakeD1Database } from './helpers/fake-d1.js';

test('historical duplicate claim still initializes queue current state', async () => {
  const observedAt = 1_751_500_160_000;
  const db = new FakeD1Database()
    .route('first', /FROM sh_queue_current/, null)
    .route('first', /WHERE data_type='queue' AND payload_hash=\?/, {
      dedupe_key: 'old-queue-claim',
      collector_id: 'integration-collector',
      collector_kind: 'local',
      source_priority: 70,
      observed_at: observedAt - 60_000,
      payload_hash: 'existing',
      first_seen_at: observedAt - 60_000,
    });

  const result = await saveLeanQueue(db, observedAt, {
    type: 'queue',
    collector_id: 'integration-collector',
    data: {
      station_id: 3328626,
      queue_id: 41,
      start_time: 1_751_500_000_000,
      is_paused: false,
      tracks: [{
        position: 0,
        queue_track_id: 100,
        stationhead_track_id: 200,
        spotify_id: 'spotify-1',
        duration_ms: 180_000,
        bite_count: 15,
      }],
    },
  });

  assert.equal(result.claim.duplicate, true);
  assert.equal(result.inspected, true);
  assert.equal(db.callsMatching(/INSERT INTO sh_queue_current/, 'run').length, 1);
  assert.equal(db.callsMatching(/INSERT INTO sh_queue_snapshots/, 'run').length, 0);
});
