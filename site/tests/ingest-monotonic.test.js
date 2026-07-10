import assert from 'node:assert/strict';
import test from 'node:test';

import { saveLeanQueue, saveLeanHeartbeat } from '../functions/lib/d1-optimized-ingest.js';
import {
  observationTrackKey,
  planLikeCurrentMigrations,
  planLikeObservations,
  queueStructuralPayload,
  saveLeanSnapshot,
} from '../functions/lib/d1-lean-ingest.js';
import { payloadHash } from '../functions/lib/ingest-claim.js';
import { FakeD1Database } from './helpers/fake-d1.js';

test('persisted like keys prefer ISRC and fall back to Spotify', () => {
  assert.equal(observationTrackKey({
    queue_track_id: 123,
    spotify_id: 'spotify-id',
    isrc: 'jpabc1234567',
  }), 'isrc:JPABC1234567');
  assert.equal(observationTrackKey({ spotify_id: 'spotify-id' }), 'spotify:spotify-id');
  assert.equal(observationTrackKey({ queue_track_id: 123 }), null);
  assert.equal(observationTrackKey({ stationhead_track_id: 456 }), null);
});

test('legacy current rows migrate by preferred identity without duplicating history', () => {
  const isrcTracks = [{ position: 0, spotify_id: 'spotify-a', isrc: 'jpabc1234567', bite_count: 10 }];
  const isrcRows = [{
    track_key: 'old-non-isrc-key',
    spotify_id: 'spotify-a',
    isrc: 'JPABC1234567',
    like_count: 10,
    observed_at: 100,
  }];
  assert.equal(planLikeObservations(isrcTracks, isrcRows).length, 0);
  assert.deepEqual(
    planLikeCurrentMigrations(isrcTracks, isrcRows).map(({ trackKey }) => trackKey),
    ['isrc:JPABC1234567'],
  );

  const spotifyTracks = [{ position: 0, spotify_id: 'spotify-fallback', bite_count: 7 }];
  const spotifyRows = [{
    track_key: 'old-spotify-key',
    spotify_id: 'spotify-fallback',
    isrc: null,
    like_count: 7,
    observed_at: 100,
  }];
  assert.equal(planLikeObservations(spotifyTracks, spotifyRows).length, 0);
  assert.deepEqual(
    planLikeCurrentMigrations(spotifyTracks, spotifyRows).map(({ trackKey }) => trackKey),
    ['spotify:spotify-fallback'],
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
        observed_at: 1_000,
        latest_reachability_at: 2_000,
      },
    },
  ]);
  const result = await saveLeanQueue(db, 1_500, {
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
        isrc: 'JPABC1234567',
        duration_ms: 180_000,
        bite_count: 4,
      }],
    },
  });

  assert.equal(result.staleCurrent, true);
  const statements = db.batches.flat();
  assert.equal(statements.some(({ sql }) => /^DELETE FROM sh_queue_items/i.test(sql.trim())), false);
  assert.equal(statements.some(({ sql }) => /^DELETE FROM sh_track_like_current/i.test(sql.trim())), false);
  assert.equal(statements.some(({ sql }) => /INSERT INTO sh_queue_current/.test(sql)), false);

  const itemUpsert = statements.find(({ sql }) => /INSERT INTO sh_queue_items/.test(sql));
  const likeUpsert = statements.find(({ sql }) => /INSERT INTO sh_track_like_current/.test(sql));
  const historyInsert = statements.find(({ sql }) => /INSERT INTO sh_track_like_observations/.test(sql));
  assert.match(itemUpsert.sql, /MAX\(snapshot\.observed_at\)/);
  assert.match(likeUpsert.sql, /MAX\(snapshot\.observed_at\)/);
  assert.ok(historyInsert);
  assert.ok(likeUpsert.params.includes('isrc:JPABC1234567'));
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
      isrc: 'JPABC1234567',
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
        latest_reachability_at: 1_000,
      },
    },
  ]);

  const result = await saveLeanQueue(db, 2_000, { data });

  assert.equal(result.structureChanged, false);
  assert.equal(result.likesChanged, true);
  const likeFallbackUpdate = db.batches.flat().find(({ sql }) => /^UPDATE sh_queue_items/i.test(sql.trim()));
  assert.ok(likeFallbackUpdate);
  assert.deepEqual(likeFallbackUpdate.params.slice(0, 4), [7, 1, 900, 0]);
  assert.match(likeFallbackUpdate.sql, /MAX\(snapshot\.observed_at\)/);
});

test('Spotify fallback writes current and historical likes when ISRC is missing', async () => {
  const data = {
    station_id: 1,
    queue_id: 2,
    start_time: 900,
    is_paused: false,
    tracks: [{
      position: 0,
      queue_track_id: 123,
      spotify_id: 'spotify-fallback',
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
        latest_reachability_at: 1_000,
      },
    },
  ]);

  await saveLeanQueue(db, 2_000, { data });
  const statements = db.batches.flat();
  const current = statements.find(({ sql }) => /INSERT INTO sh_track_like_current/.test(sql));
  const history = statements.find(({ sql }) => /INSERT INTO sh_track_like_observations/.test(sql));
  assert.ok(current);
  assert.ok(history);
  assert.ok(current.params.includes('spotify:spotify-fallback'));
  assert.ok(history.params.includes('spotify:spotify-fallback'));
});

test('tracks without ISRC or Spotify do not write like identities', async () => {
  const data = {
    station_id: 1,
    queue_id: 2,
    start_time: 900,
    is_paused: false,
    tracks: [{
      position: 0,
      queue_track_id: 123,
      stationhead_track_id: 456,
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
        latest_reachability_at: 1_000,
      },
    },
  ]);

  await saveLeanQueue(db, 2_000, { data });
  const statements = db.batches.flat();
  assert.equal(statements.some(({ sql }) => /INSERT INTO sh_track_like_current/.test(sql)), false);
  assert.equal(statements.some(({ sql }) => /INSERT INTO sh_track_like_observations/.test(sql)), false);
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
