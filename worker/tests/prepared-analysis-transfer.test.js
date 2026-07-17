import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeQueueLikes,
} from '../../site/functions/lib/d1-optimized-ingest.js';
import {
  queueStructuralPayload,
  saveLeanSnapshot,
} from '../../site/functions/lib/d1-lean-ingest.js';
import {
  restoreQueueAnalysis,
  serializedQueueAnalysis,
} from '../src/queue-analysis-transfer.js';
import {
  prepareSnapshotAnalysis,
  restoreSnapshotAnalysis,
  savePreparedSnapshot,
} from '../src/snapshot-analysis-transfer.js';

const STRUCTURAL = Symbol.for('stationhead.queue.structural-payload');
const LIKES = Symbol.for('stationhead.queue.like-analysis');

function statement(sql, calls) {
  return {
    bind(...binds) {
      const bound = {
        sql,
        binds,
        async first() {
          calls.push({ method: 'first', sql, binds });
          return null;
        },
        async run() {
          calls.push({ method: 'run', sql, binds });
          return { meta: { changes: 1 } };
        },
      };
      return bound;
    },
  };
}

function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return statement(sql, calls);
    },
    async batch(statements) {
      calls.push({
        method: 'batch',
        statements: statements.map((item) => ({ sql: item.sql, binds: item.binds })),
      });
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

function snapshot() {
  return {
    channel_id: 10,
    channel_alias: 'buddies',
    channel_name: 'Buddies',
    station_id: 20,
    is_launched: true,
    is_broadcasting: true,
    chat_status: 'open',
    listener_count: 30,
    online_member_count: 40,
    total_member_count: 50,
    guest_count: 2,
    total_listens: 60,
    stream_goal: 100,
    current_stream_count: 70,
    host_account_id: 80,
    host_handle: 'host',
    broadcast_start_time: 90,
    presentation: {
      description: 'description',
      artist_name: 'artist',
      accent_color: '#fff',
      images: {
        medium: { url: 'medium' },
        logo: { medium: { url: 'logo' } },
      },
      current_station: {
        status: 'live',
        owner: {
          thumbnail: { url: 'thumb' },
          medium: { url: 'owner-medium' },
        },
      },
    },
  };
}

test('queue structural and like analyses survive JSON Queue transport', () => {
  const queue = {
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    is_paused: 0,
    tracks: [{ position: 0, isrc: 'JPABC', bite_count: 5 }],
  };
  const structural = {
    station_id: 20,
    queue_id: 30,
    start_time: 40,
    is_paused: 0,
    tracks: [{
      position: 0,
      queue_track_id: null,
      stationhead_track_id: null,
      spotify_id: null,
      deezer_id: null,
      isrc: 'JPABC',
      duration_ms: null,
      preview_url: null,
    }],
  };
  const likes = { complete: true, payload: [{ track_key: 'isrc:JPABC', like_count: 5 }] };
  Object.defineProperty(queue, STRUCTURAL, { value: structural });
  Object.defineProperty(queue.tracks, LIKES, { value: likes });

  const transported = JSON.parse(JSON.stringify({
    queue,
    analysis: serializedQueueAnalysis(queue),
  }));
  restoreQueueAnalysis(transported.queue, transported.analysis);

  assert.equal(queueStructuralPayload(transported.queue), transported.analysis.structural);
  assert.deepEqual(analyzeQueueLikes(transported.queue.tracks), transported.analysis.likes);
});

test('prepared snapshot persistence keeps the existing SQL and bind format', async () => {
  const observedAt = 1_784_000_000_000;
  const originalDb = fakeDb();
  const preparedDb = fakeDb();
  const originalNow = Date.now;
  Date.now = () => observedAt + 1;
  try {
    await saveLeanSnapshot(originalDb, observedAt, snapshot());
    const prepared = snapshot();
    const analysis = await prepareSnapshotAnalysis(prepared);
    const transported = JSON.parse(JSON.stringify({ prepared, analysis }));
    restoreSnapshotAnalysis(transported.prepared, transported.analysis);
    await savePreparedSnapshot(preparedDb, observedAt, transported.prepared);
  } finally {
    Date.now = originalNow;
  }

  const originalBatch = originalDb.calls.find((call) => call.method === 'batch');
  const preparedBatch = preparedDb.calls.find((call) => call.method === 'batch');
  assert.deepEqual(preparedBatch, originalBatch);
});
