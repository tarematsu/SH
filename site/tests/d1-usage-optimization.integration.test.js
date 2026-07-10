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

test('like history is written only when the ISRC value changes', () => {
  const tracks = [{ position: 0, isrc: 'jpabc1234567', bite_count: 10 }];
  assert.equal(planLikeObservations(tracks, [
    { track_key: 'legacy-key', isrc: 'JPABC1234567', like_count: 10 },
  ]).length, 0);
  assert.equal(planLikeObservations(tracks, [
    { track_key: 'legacy-key', isrc: 'JPABC1234567', like_count: 9 },
  ]).length, 1);
  assert.equal(planLikeObservations([
    { position: 0, spotify_id: 'abc', bite_count: 10 },
  ], []).length, 0);
});

test('queue like hash payload uses only ISRC and is stable across ordering', () => {
  const first = queueLikesPayload([
    { spotify_id: 'b', isrc: 'jpbbb0000002', bite_count: 2 },
    { spotify_id: 'a', isrc: 'jpaaa0000001', bite_count: 1 },
    { spotify_id: 'ignored', bite_count: 99 },
  ]);
  const second = queueLikesPayload([
    { spotify_id: 'ignored-other', bite_count: 500 },
    { spotify_id: 'a2', isrc: 'JPAAA0000001', bite_count: 1 },
    { spotify_id: 'b2', isrc: 'JPBBB0000002', bite_count: 2 },
  ]);

  assert.deepEqual(first, second);
  assert.deepEqual(first.map((row) => row.track_key), [
    'isrc:JPAAA0000001',
    'isrc:JPBBB0000002',
  ]);
});

test('only ISRC-bearing tracks determine like snapshot completeness', () => {
  assert.equal(hasCompleteLikeSnapshot([]), true);
  assert.equal(hasCompleteLikeSnapshot([
    { isrc: 'JPAAA0000001', bite_count: 1 },
    { isrc: 'JPBBB0000002', bite_count: 2 },
    { spotify_id: 'ignored-without-isrc' },
  ]), true);
  assert.equal(hasCompleteLikeSnapshot([
    { isrc: 'JPAAA0000001', bite_count: 1 },
    { isrc: 'JPBBB0000002' },
  ]), false);
});

test('structural-only queue changes do not reconcile current likes', async () => {
  const data = {
    station_id: 1,
    queue_id: 2,
    start_time: 3,
    is_paused: false,
    tracks: [{
      position: 0,
      spotify_id: 'abc',
      isrc: 'JPABC1234567',
      duration_ms: 1000,
      bite_count: 10,
    }],
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
