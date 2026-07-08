import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planLikeObservations,
  queueItemsToWriteLean,
  queueStructuralPayload,
} from '../functions/lib/d1-lean-ingest.js';
import {
  D1_BATCH_VARIABLE_LIMIT,
  hasCompleteLikeSnapshot,
  queueLikesPayload,
  saveLeanQueue,
} from '../functions/lib/d1-optimized-ingest.js';
import { payloadHash } from '../functions/lib/ingest-claim.js';
import { FakeD1Database } from './helpers/fake-d1.js';

test('queue identity ignores bite-only and raw response changes', () => {
  const base = { station_id: 1, queue_id: 2, start_time: 3 };
  const first = queueStructuralPayload({
    ...base,
    tracks: [{ position: 0, spotify_id: 'abc', duration_ms: 1000, bite_count: 10, raw: { likes: 10 } }],
  });
  const second = queueStructuralPayload({
    ...base,
    tracks: [{ position: 0, spotify_id: 'abc', duration_ms: 1000, bite_count: 99, raw: { likes: 99 } }],
  });
  assert.deepEqual(first, second);
});

test('queue rows are not rewritten for bite-only changes', () => {
  const changed = queueItemsToWriteLean([
    { position: 0, queue_id: 2, spotify_id: 'abc', duration_ms: 1000, bite_count: 99 },
  ], [
    { position: 0, queue_id: 2, spotify_id: 'abc', duration_ms: 1000, bite_count: 10 },
  ], 2);
  assert.deepEqual(changed, []);
});

test('like history is written only when the value changes', () => {
  const tracks = [{ position: 0, spotify_id: 'abc', bite_count: 10 }];
  assert.equal(planLikeObservations(tracks, [{ track_key: 'abc', like_count: 10 }]).length, 0);
  assert.equal(planLikeObservations(tracks, [{ track_key: 'abc', like_count: 9 }]).length, 1);
});

test('queue like hash payload is stable across track ordering', () => {
  const first = queueLikesPayload([
    { spotify_id: 'b', bite_count: 2 },
    { spotify_id: 'a', bite_count: 1 },
  ]);
  const second = queueLikesPayload([
    { spotify_id: 'a', bite_count: 1 },
    { spotify_id: 'b', bite_count: 2 },
  ]);
  assert.deepEqual(first, second);
});

test('partial like snapshots remain non-authoritative', () => {
  assert.equal(hasCompleteLikeSnapshot([]), true);
  assert.equal(hasCompleteLikeSnapshot([
    { spotify_id: 'a', bite_count: 1 },
    { spotify_id: 'b', bite_count: 2 },
  ]), true);
  assert.equal(hasCompleteLikeSnapshot([
    { spotify_id: 'a', bite_count: 1 },
    { spotify_id: 'b' },
  ]), false);
});

test('structural-only queue changes do not reconcile current likes', async () => {
  const data = {
    station_id: 1,
    queue_id: 2,
    start_time: 3,
    is_paused: false,
    tracks: [{ position: 0, spotify_id: 'abc', duration_ms: 1000, bite_count: 10 }],
  };
  const likesHash = await payloadHash(queueLikesPayload(data.tracks));
  const db = new FakeD1Database([
    {
      kind: 'first',
      matcher: 'FROM sh_queue_current',
      result: { structural_hash: 'previous-structure', likes_hash: likesHash, start_time: 3 },
    },
  ]);

  const result = await saveLeanQueue(db, 1_700_000_000_000, {
    collector_id: 'cloudflare-worker',
    data,
  });
  const batchedSql = db.batches.flatMap((batch) => batch.map((statement) => statement.sql));

  assert.equal(result.structureChanged, true);
  assert.equal(result.likesChanged, false);
  assert.equal(batchedSql.some((sql) => sql.includes('DELETE FROM sh_queue_items')), true);
  assert.equal(batchedSql.some((sql) => sql.includes('DELETE FROM sh_track_like_current')), false);
});

test('queue reads and writes keep D1 batch bind counts under the configured limit', async () => {
  const data = {
    station_id: 1,
    queue_id: 2,
    start_time: 3,
    is_paused: false,
    tracks: Array.from({ length: 160 }, (_, index) => ({
      position: index,
      queue_track_id: 1000 + index,
      stationhead_track_id: 2000 + index,
      spotify_id: `spotify-${index}`,
      isrc: `ISRC${String(index).padStart(8, '0')}`,
      duration_ms: 180000,
      bite_count: index,
    })),
  };
  const db = new FakeD1Database([
    {
      kind: 'first',
      matcher: 'FROM sh_queue_current',
      result: { structural_hash: 'previous-structure', likes_hash: 'previous-likes', start_time: 3 },
    },
  ]);

  const result = await saveLeanQueue(db, 1_700_000_000_000, {
    collector_id: 'cloudflare-worker',
    data,
  });

  assert.equal(result.structureChanged, true);
  assert.equal(result.likesChanged, true);
  assert.ok(db.batches.length > 1);

  for (const batch of db.batches) {
    const bindCount = batch.reduce((sum, statement) => sum + statement.params.length, 0);
    assert.ok(
      bindCount <= D1_BATCH_VARIABLE_LIMIT,
      `batch bind count ${bindCount} exceeds ${D1_BATCH_VARIABLE_LIMIT}`,
    );
  }
});
