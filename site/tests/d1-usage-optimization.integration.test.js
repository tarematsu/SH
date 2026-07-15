import assert from 'node:assert/strict';
import test from 'node:test';

import { extractQueue } from '../../worker/src/collector-payload.js';

import {
  planLikeObservations,
  queueItemsToWriteLean,
  queueStructuralPayload,
} from '../functions/lib/d1-lean-ingest.js';
import {
  D1_BATCH_VARIABLE_LIMIT,
  analyzeQueueLikes,
  hasCompleteLikeSnapshot,
  queueLikesPayload,
  resetQueueHashCacheForTests,
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

test('like history uses ISRC first and Spotify only when ISRC is missing', () => {
  const isrcTrack = [{ position: 0, spotify_id: 'spotify-a', isrc: 'jpabc1234567', bite_count: 10 }];
  assert.equal(planLikeObservations(isrcTrack, [
    { track_key: 'legacy-key', spotify_id: 'other', isrc: 'JPABC1234567', like_count: 10 },
  ]).length, 0);
  assert.equal(planLikeObservations(isrcTrack, [
    { track_key: 'spotify:spotify-a', spotify_id: 'spotify-a', like_count: 10 },
  ]).length, 1);

  const spotifyTrack = [{ position: 0, spotify_id: 'spotify-fallback', bite_count: 7 }];
  assert.equal(planLikeObservations(spotifyTrack, [
    { track_key: 'legacy-key', spotify_id: 'spotify-fallback', like_count: 7 },
  ]).length, 0);
  assert.equal(planLikeObservations([{ position: 0, bite_count: 7 }], []).length, 0);
});

test('queue like hash payload follows ISRC then Spotify priority and stays ordered', () => {
  const first = queueLikesPayload([
    { spotify_id: 'spotify-b', isrc: 'jpbbb0000002', bite_count: 2 },
    { spotify_id: 'spotify-a', isrc: 'jpaaa0000001', bite_count: 1 },
    { spotify_id: 'spotify-fallback', bite_count: 3 },
    { queue_track_id: 99, bite_count: 99 },
  ]);
  const second = queueLikesPayload([
    { queue_track_id: 100, bite_count: 500 },
    { spotify_id: 'spotify-fallback', bite_count: 3 },
    { spotify_id: 'changed-a', isrc: 'JPAAA0000001', bite_count: 1 },
    { spotify_id: 'changed-b', isrc: 'JPBBB0000002', bite_count: 2 },
  ]);

  assert.deepEqual(first, second);
  assert.deepEqual(first.map((row) => row.track_key), [
    'isrc:JPAAA0000001',
    'isrc:JPBBB0000002',
    'spotify:spotify-fallback',
  ]);
});

test('ISRC and Spotify fallback tracks determine like snapshot completeness', () => {
  assert.equal(hasCompleteLikeSnapshot([]), true);
  assert.equal(hasCompleteLikeSnapshot([
    { isrc: 'JPAAA0000001', bite_count: 1 },
    { spotify_id: 'spotify-fallback', bite_count: 2 },
    { queue_track_id: 123 },
  ]), true);
  assert.equal(hasCompleteLikeSnapshot([
    { isrc: 'JPAAA0000001', bite_count: 1 },
    { spotify_id: 'spotify-fallback' },
  ]), false);
});

test('collector compact queues reuse canonical structural and like analyses', () => {
  const queue = extractQueue({
    current_station: {
      id: 5,
      queue: {
        id: 9,
        start_time: 100,
        is_paused: false,
        queue_tracks: [{
          id: 3,
          track: {
            id: 7,
            spotify_id: 'spotify-7',
            isrc: 'jpabc1234567',
            duration: '180000',
            bite_count: '4',
          },
        }],
      },
    },
  }, 5);
  const plainQueue = JSON.parse(JSON.stringify(queue));

  assert.deepEqual(queueStructuralPayload(queue), queueStructuralPayload(plainQueue));
  assert.deepEqual(analyzeQueueLikes(queue.tracks), analyzeQueueLikes(plainQueue.tracks));
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

test('unchanged queue payloads reuse hashes within the worker isolate', async () => {
  resetQueueHashCacheForTests();
  const data = {
    station_id: 1,
    queue_id: 2,
    start_time: 3,
    is_paused: false,
    tracks: [{ position: 0, spotify_id: 'abc', duration_ms: 1000, bite_count: 10 }],
  };
  const structuralHash = await payloadHash(queueStructuralPayload(data));
  const likesHash = await payloadHash(queueLikesPayload(data.tracks));
  const db = new FakeD1Database([
    {
      kind: 'first',
      matcher: 'FROM sh_queue_current',
      result: { structural_hash: structuralHash, likes_hash: likesHash, start_time: 3 },
    },
  ]);
  const originalDigest = crypto.subtle.digest;
  let digestCalls = 0;
  crypto.subtle.digest = async (...args) => {
    digestCalls += 1;
    return originalDigest.apply(crypto.subtle, args);
  };
  try {
    await saveLeanQueue(db, 1_700_000_000_000, { data });
    const firstCallCount = digestCalls;
    await saveLeanQueue(db, 1_700_000_060_000, { data });
    assert.equal(firstCallCount, 2);
    assert.equal(digestCalls, firstCallCount);
  } finally {
    crypto.subtle.digest = originalDigest;
    resetQueueHashCacheForTests();
  }
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
      isrc: index % 2 === 0 ? `ISRC${String(index).padStart(8, '0')}` : null,
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
