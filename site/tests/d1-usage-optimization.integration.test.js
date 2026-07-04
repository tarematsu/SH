import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planLikeObservations,
  queueItemsToWriteLean,
  queueStructuralPayload,
} from '../functions/lib/d1-lean-ingest.js';

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
