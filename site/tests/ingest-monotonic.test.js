import assert from 'node:assert/strict';
import test from 'node:test';

import { saveLeanQueue, saveLeanHeartbeat } from '../functions/lib/d1-optimized-ingest.js';
import {
  observationTrackKey,
  queueStructuralPayload,
  saveLeanSnapshot,
} from '../functions/lib/d1-lean-ingest.js';
import { payloadHash } from '../functions/lib/ingest-claim.js';
import { FakeD1Database } from './helpers/fake-d1.js';

test('persisted track keys keep ID namespaces distinct', () => {
  assert.equal(observationTrackKey({ queue_track_id: 123, spotify_id: '123' }), 'queue:123');
  assert.equal(observationTrackKey({ spotify_id: '123' }), 'spotify:123');
  assert.equal(observationTrackKey({ isrc: 'jpabc1234567' }), 'isrc:JPABC1234567');
  assert.notEqual(
    observationTrackKey({ queue_track_id: 123 }),
    observationTrackKey({ spotify_id: '123' }),
  );
});

test('delayed queue payloads preserve history without deleting or regressing current rows', async () => {
  const db = new FakeD1Database([
    {
      kind: 'first',
      matcher: /FROM sh_queue_current/,
      result: {
        structural_hash: 'newer-structure',
        likes_hash: 'newer-likes',
        start_time: 900,
        observed_at: 2_000,
      },
    },
  ]);
  const result = await saveLeanQueue(db, 1_000, {
    collector_id: 'delayed-collector',
    data: {
      station_id: 1,
      queue_id: 2,
      start_time: 900,
      is_paused: false,
      tracks: [{
        position: 0,
        queue_track_id: 123,
        spotify_id: 'spotify-old',
        duration_ms: 180_000,
        bite_count: 4,
      }],
    },
  });

  assert.equal(result.staleCurrent, true);
  const statements = db.batches.flat();
  assert.equal(statements.some(({ sql }) => /^DELETE FROM sh_queue_items/i.test(sql.trim())), false);
  assert.equal(statements.some(({ sql }) => /^DELETE FROM sh_track_like_current/i.test(sql.trim())), false);

  const itemUpsert = statements.find(({ sql }) => /INSERT INTO sh_queue_items/.test(sql));
  const likeUpsert = statements.find(({ sql }) => /INSERT INTO sh_track_like_current/.test(sql));
  const currentUpsert = statements.find(({ sql }) => /INSERT INTO sh_queue_current/.test(sql));
  assert.match(itemUpsert.sql, /excluded\.observed_at>=sh_queue_items\.observed_at/);
  assert.match(likeUpsert.sql, /excluded\.observed_at>=sh_track_like_current\.observed_at/);
  assert.match(currentUpsert.sql, /excluded\.observed_at>=sh_queue_current\.observed_at/);
});

test('likes-only queue updates refresh the queue item fallback count', async () => {
  const data = {
    station_id: 1,
    queue_id: 2,
    start_time: 900,
    is_paused: false,
    tracks: [{
      position: 0,
      queue_track_id: 123,
      spotify_id: 'spotify-current',
      duration_ms: 180_000,
      bite_count: 7,
    }],
  };
  const structuralHash = await payloadHash(queueStructuralPayload(data));
  const db = new FakeD1Database([
    {
      kind: 'first',
      matcher: /FROM sh_queue_current/,
      result: {
        structural_hash: structuralHash,
        likes_hash: 'old-like-hash',
        start_time: 900,
        observed_at: 1_000,
      },
    },
  ]);

  const result = await saveLeanQueue(db, 2_000, { data });

  assert.equal(result.structureChanged, false);
  assert.equal(result.likesChanged, true);
  const likeFallbackUpdate = db.batches.flat().find(({ sql }) => /^UPDATE sh_queue_items/i.test(sql.trim()));
  assert.ok(likeFallbackUpdate);
  assert.deepEqual(likeFallbackUpdate.params.slice(0, 4), [7, 1, 900, 0]);
});

test('snapshot and heartbeat current tables reject older timestamps', async () => {
  const snapshotDb = new FakeD1Database([
    {
      kind: 'first',
      matcher: /FROM sh_snapshot_current/,
      result: {
        payload_hash: 'newer',
        last_snapshot_at: 2_000,
        last_stream_count: 100,
        last_stream_at: 2_000,
      },
    },
  ]);
  await saveLeanSnapshot(snapshotDb, 1_000, {
    channel_id: 1,
    station_id: 2,
    is_launched: true,
    is_broadcasting: true,
    listener_count: 10,
    current_stream_count: 100,
  });
  const snapshotCurrent = snapshotDb.batches.flat().find(({ sql }) => /INSERT INTO sh_snapshot_current/.test(sql));
  assert.match(snapshotCurrent.sql, /excluded\.last_snapshot_at>=COALESCE\(sh_snapshot_current\.last_snapshot_at,0\)/);

  const heartbeatDb = new FakeD1Database();
  await saveLeanHeartbeat(heartbeatDb, 1_000, {
    collector_id: 'collector',
    hostname: 'host',
    version: '1',
  });
  const heartbeat = heartbeatDb.calls.find(({ sql }) => /INSERT INTO sh_collector_heartbeats/.test(sql));
  assert.match(heartbeat.sql, /excluded\.last_seen_at>=sh_collector_heartbeats\.last_seen_at/);
});
