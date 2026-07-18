import assert from 'node:assert/strict';
import test from 'node:test';

import {
  D1_SINGLE_STATEMENT_VARIABLE_LIMIT,
  saveLeanQueue,
} from '../functions/lib/d1-optimized-ingest.js';
import { FakeD1Database } from './helpers/fake-d1.js';

function queue(trackCount) {
  return {
    station_id: 1,
    queue_id: 2,
    start_time: 3,
    is_paused: false,
    tracks: Array.from({ length: trackCount }, (_value, position) => ({
      position,
      queue_track_id: 1_000 + position,
      stationhead_track_id: 2_000 + position,
      spotify_id: `spotify-${position}`,
      isrc: `JPTEST${String(position).padStart(6, '0')}`,
      duration_ms: 180_000,
      bite_count: position,
    })),
  };
}

test('22 new queue rows use four grouped upserts without redundant bite updates', async () => {
  const db = new FakeD1Database([{
    kind: 'first',
    matcher: 'FROM sh_queue_current',
    result: {
      structural_hash: 'previous-structure',
      likes_hash: 'previous-likes',
      start_time: 3,
      observed_at: 0,
    },
  }]);

  const result = await saveLeanQueue(db, 1_700_000_000_000, {
    collector_id: 'cloudflare-worker',
    data: queue(22),
  });
  const statements = db.batches.flat();
  const itemUpserts = statements.filter((statement) => (
    statement.sql.includes('INSERT INTO sh_queue_items')
  ));
  const redundantLikeUpdates = statements.filter((statement) => (
    statement.sql.includes('UPDATE sh_queue_items')
    && statement.sql.includes('SET bite_count=')
  ));

  assert.equal(result.itemsWritten, 22);
  assert.equal(itemUpserts.length, 4);
  assert.deepEqual(itemUpserts.map((statement) => statement.params.length), [84, 84, 84, 56]);
  assert.ok(itemUpserts.every((statement) => (
    statement.params.length <= D1_SINGLE_STATEMENT_VARIABLE_LIMIT
  )));
  assert.equal(redundantLikeUpdates.length, 0);
});
