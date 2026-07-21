import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareSparseLiveRevision } from '../src/minute-revision-materializer.js';

const payload = {
  payload_version: 1,
  observedAt: 370_000,
  snapshot: {
    channel_id: 10,
    station_id: 20,
    is_broadcasting: 1,
  },
  queue: {
    station_id: 20,
    queue_id: 40,
    start_time: 10_000,
    current_position: 0,
    total_track_count: 1,
    tracks: [{
      position: 0,
      queue_track_id: 100,
      stationhead_track_id: 200,
      duration_ms: 120_000,
    }],
  },
  rebuild: null,
};

test('sparse revision preparation recovers the row that won the storage-key race', async () => {
  let reusableLookups = 0;
  let inserted = 0;
  let recovered = 0;
  const result = await prepareSparseLiveRevision({
    MINUTE_DB: {},
    DERIVE_REVISION_STAGE_TRACKS: 1,
  }, payload, {
    sourceJobId: 7,
  }, {
    resolveLiveSession: async () => 50,
    findReusableRevision: async () => {
      reusableLookups += 1;
      return null;
    },
    insertRevision: async () => { inserted += 1; },
    findStoredRevision: async (_db, input) => {
      recovered += 1;
      assert.equal(input.channelId, 10);
      assert.equal(input.observedAt, 370_000);
      assert.equal(typeof input.structuralHash, 'string');
      return { id: 60, status: 'pending' };
    },
    revisionProgress: async () => 0,
    updateRevisionSource: async () => {},
  });

  assert.equal(reusableLookups, 2);
  assert.equal(inserted, 1);
  assert.equal(recovered, 1);
  assert.equal(result.revision_id, 60);
  assert.equal(result.staged, true);
});
