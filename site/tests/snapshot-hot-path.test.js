import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetSnapshotHashCacheForTests,
  saveLeanSnapshot,
} from '../functions/lib/d1-optimized-ingest.js';
import { payloadHash } from '../functions/lib/ingest-claim.js';
import { FakeD1Database } from './helpers/fake-d1.js';

const BASE = 1_700_000_000_000;

function snapshotData() {
  return {
    channel_id: 1,
    channel_alias: 'buddies',
    channel_name: 'Buddies',
    station_id: 2,
    is_launched: true,
    is_broadcasting: true,
    chat_status: 'open',
    listener_count: 10,
    online_member_count: 11,
    total_member_count: 12,
    guest_count: 3,
    total_listens: 99,
    current_stream_count: 4,
    stream_goal: 20,
    host_account_id: 5,
    host_handle: 'host',
    broadcast_start_time: BASE - 60_000,
    presentation: {
      description: 'description',
      artist_name: 'artist',
      accent_color: '#123456',
      images: {
        medium: { url: 'https://example.com/medium.jpg' },
        logo: { medium: { url: 'https://example.com/logo.jpg' } },
      },
      current_station: {
        status: 'live',
        owner: {
          thumbnail: { url: 'https://example.com/thumb.jpg' },
          medium: { url: 'https://example.com/owner.jpg' },
        },
      },
    },
  };
}

function legacyMetadata(data) {
  return {
    description: data.presentation.description,
    artist_name: data.presentation.artist_name,
    accent_color: data.presentation.accent_color,
    images: {
      medium: { url: data.presentation.images.medium.url },
      logo: { medium: { url: data.presentation.images.logo.medium.url } },
    },
    current_station: {
      status: data.presentation.current_station.status,
      owner: {
        thumbnail: { url: data.presentation.current_station.owner.thumbnail.url },
        medium: { url: data.presentation.current_station.owner.medium.url },
      },
    },
  };
}

function legacyHashPayload(data) {
  return {
    channel_id: 1,
    station_id: 2,
    is_launched: 1,
    is_broadcasting: 1,
    chat_status: 'open',
    listener_count: 10,
    online_member_count: 11,
    total_member_count: 12,
    guest_count: 3,
    cumulative_listener_count: 99,
    reported_stream_count: 4,
    stream_goal: 20,
    host_account_id: 5,
    host_handle: 'host',
    broadcast_start_time: BASE - 60_000,
    metadata: legacyMetadata(data),
  };
}

test('snapshot hot path preserves hashes and materializes persistence only for writes', async () => {
  resetSnapshotHashCacheForTests();
  const data = snapshotData();
  const expectedHash = await payloadHash(legacyHashPayload(data));
  const expectedRaw = JSON.stringify(legacyMetadata(data));
  let current = { payload_hash: 'previous', last_snapshot_at: 0 };
  const db = new FakeD1Database([{
    kind: 'first',
    matcher: /FROM sh_snapshot_current/,
    result: () => current,
  }]);

  const originalDigest = crypto.subtle.digest;
  let digestCalls = 0;
  crypto.subtle.digest = async (...args) => {
    digestCalls += 1;
    return originalDigest.apply(crypto.subtle, args);
  };

  try {
    const first = await saveLeanSnapshot(db, BASE, data);
    assert.equal(first.inserted, true);
    assert.equal(digestCalls, 1);
    assert.equal(db.batches.length, 1);
    const firstSnapshot = db.batches[0].find(({ sql }) => sql.includes('INSERT INTO sh_channel_snapshots'));
    const firstCurrent = db.batches[0].find(({ sql }) => sql.includes('INSERT INTO sh_snapshot_current'));
    assert.equal(firstSnapshot.params.at(-1), expectedRaw);
    assert.equal(firstCurrent.params[1], expectedHash);

    current = { payload_hash: expectedHash, last_snapshot_at: BASE };
    const repeated = await saveLeanSnapshot(db, BASE + 60_000, data);
    assert.equal(repeated.skipped, true);
    assert.equal(digestCalls, 1);
    assert.equal(db.batches.length, 1);

    const checkpoint = await saveLeanSnapshot(db, BASE + 5 * 60_000, data);
    assert.equal(checkpoint.inserted, true);
    assert.equal(digestCalls, 1);
    assert.equal(db.batches.length, 2);
    const checkpointSnapshot = db.batches[1].find(({ sql }) => sql.includes('INSERT INTO sh_channel_snapshots'));
    const checkpointCurrent = db.batches[1].find(({ sql }) => sql.includes('INSERT INTO sh_snapshot_current'));
    assert.equal(checkpointSnapshot.params.at(-1), expectedRaw);
    assert.equal(checkpointCurrent.params[1], expectedHash);
  } finally {
    crypto.subtle.digest = originalDigest;
    resetSnapshotHashCacheForTests();
  }
});
